import { db } from '$lib/catalog/db';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { liveQuery } from 'dexie';
import { derived, get, readable, writable, type Readable } from 'svelte/store';
import { deriveSeriesFromVolumes } from '$lib/catalog/catalog';
import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
import { generatePlaceholders } from '$lib/catalog/placeholders';
import { routeParams } from '$lib/util/hash-router';
import { getLegacyImageOnlyVolumeUuid } from '$lib/util/download-volume-repair';
import { serverLibraryVolumes, loadServerVolumeData } from '$lib/catalog/server-library';
import { progress as readingProgress } from '$lib/settings/volume-data';

async function loadCurrentVolumeData(
  volume: VolumeMetadata,
  onProgress?: (partial: VolumeData) => void
): Promise<VolumeData | undefined> {
  if (volume.isServerLibrary) {
    // Resume where the reader last left off: prioritize fetching that page
    // (and its neighbors) first instead of the volume's page order, so a
    // reader reopening partway through a volume doesn't wait on unrelated
    // earlier pages before seeing the one they actually landed on.
    const savedPage = get(readingProgress)[volume.volume_uuid];
    const startIndex = savedPage ? savedPage - 1 : 0;
    return loadServerVolumeData(volume.volume_uuid, onProgress, startIndex);
  }

  let [ocr, files] = await Promise.all([
    db.volume_ocr.get(volume.volume_uuid),
    db.volume_files.get(volume.volume_uuid)
  ]);

  if (!ocr || !files) {
    const legacyUuid = getLegacyImageOnlyVolumeUuid(volume);
    if (legacyUuid) {
      const [legacyMetadata, legacyOcr, legacyFiles] = await Promise.all([
        db.volumes.get(legacyUuid),
        db.volume_ocr.get(legacyUuid),
        db.volume_files.get(legacyUuid)
      ]);

      // Repair legacy cloud image-only downloads that stored OCR/files under the
      // old deterministic UUID instead of the canonical placeholder UUID.
      if (!legacyMetadata && (legacyOcr || legacyFiles)) {
        await db.transaction('rw', [db.volume_ocr, db.volume_files], async () => {
          if (!ocr && legacyOcr) {
            ocr = { ...legacyOcr, volume_uuid: volume.volume_uuid };
            await db.volume_ocr.put(ocr);
            await db.volume_ocr.delete(legacyUuid);
          }

          if (!files && legacyFiles) {
            files = { ...legacyFiles, volume_uuid: volume.volume_uuid };
            await db.volume_files.put(files);
            await db.volume_files.delete(legacyUuid);
          }
        });
      }
    }
  }

  if (!ocr) {
    return undefined;
  }

  return {
    volume_uuid: volume.volume_uuid,
    pages: ocr.pages,
    files: files?.files
  };
}

// Single source of truth from the database
export const volumes = readable<Record<string, VolumeMetadata>>({}, (set) => {
  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();

    return volumesArray.reduce(
      (acc, vol) => {
        acc[vol.volume_uuid] = vol;
        return acc;
      },
      {} as Record<string, VolumeMetadata>
    );
  }).subscribe({
    next: (value) => set(value),
    error: (err) => console.error(err)
  });

  return () => subscription.unsubscribe();
});

// Merge local volumes with cloud placeholders and the self-hosted server library
export const volumesWithPlaceholders = derived(
  [volumes, unifiedCloudManager.cloudFiles, serverLibraryVolumes],
  ([$volumes, $cloudFiles, $serverLibraryVolumes]) => {
    const combined = { ...$volumes, ...$serverLibraryVolumes };
    const localVolumes = Object.values($volumes);

    // Generate cloud provider placeholders
    if ($cloudFiles.size > 0) {
      const cloudPlaceholders = generatePlaceholders($cloudFiles, localVolumes);
      for (const placeholder of cloudPlaceholders) {
        combined[placeholder.volume_uuid] = placeholder;
      }
    }

    return combined;
  },
  {} as Record<string, VolumeMetadata>
);

// Each derived store needs to be passed as an array if using multiple inputs
export const catalog = derived([volumesWithPlaceholders], ([$volumesWithPlaceholders]) => {
  // Return null while loading (before first data emission)
  if ($volumesWithPlaceholders === undefined) {
    return null;
  }
  return deriveSeriesFromVolumes(Object.values($volumesWithPlaceholders));
});

export const currentSeries = derived([routeParams, catalog], ([$routeParams, $catalog]) => {
  if (!$catalog || !$routeParams.manga) return [];

  const routeKey = $routeParams.manga.trim().replace(/\s+/g, ' ').toLowerCase();
  // Primary: match by title (folder name) - handles placeholder→local transition
  let series = $catalog.find((s) => s.title.trim().replace(/\s+/g, ' ').toLowerCase() === routeKey);

  // Fallback: match by UUID (for legacy URLs)
  if (!series) {
    series = $catalog.find((s) => s.series_uuid === $routeParams.manga);
  }

  return series?.volumes || [];
});

// Deliberately excludes cloud placeholders (an undownloaded cloud volume
// isn't openable until it's downloaded), but includes the server library:
// those volumes ARE fully readable right now, just not via Dexie.
export const currentVolume = derived(
  [routeParams, volumes, serverLibraryVolumes],
  ([$routeParams, $volumes, $serverLibraryVolumes]) => {
    if ($routeParams && $routeParams.volume) {
      return $volumes[$routeParams.volume] ?? $serverLibraryVolumes[$routeParams.volume];
    }
    return undefined;
  }
);

// Set while a load is in flight for the CURRENT volume, so the reader can
// show a loading state instead of "Volume not found" while e.g. a
// server-library volume's pages are still being fetched over HTTP.
const currentVolumeDataLoadingStore = writable(false);
export const currentVolumeDataLoading: Readable<boolean> = currentVolumeDataLoadingStore;

// Set when loadCurrentVolumeData() throws for the CURRENT volume (network
// failure, bad response, etc.), cleared on a successful load or on
// navigating to a different volume. Lets the reader distinguish "still
// loading"/"genuinely absent" from "failed to load" instead of collapsing
// all three into the same generic message.
const currentVolumeDataErrorStore = writable<string | undefined>(undefined);
export const currentVolumeDataError: Readable<string | undefined> = currentVolumeDataErrorStore;

export const currentVolumeData: Readable<VolumeData | undefined> = derived(
  [currentVolume],
  ([$currentVolume], set: (value: VolumeData | undefined) => void) => {
    // Track the last volume UUID so navigating between two store emissions
    // for the SAME volume (e.g. a server-library thumbnail backfilling in
    // the background) doesn't clear already-loaded data or kick off a
    // redundant fetch — only an actual navigation should do that.
    const newUuid = $currentVolume?.volume_uuid;
    if (newUuid === currentVolumeDataLastUuid) {
      return;
    }
    currentVolumeDataLastUuid = newUuid;

    // Clear old data synchronously to prevent state leaks between volumes
    set(undefined);
    currentVolumeDataErrorStore.set(undefined);

    if ($currentVolume) {
      currentVolumeDataLoadingStore.set(true);
      loadCurrentVolumeData($currentVolume, (partial) => {
        // Ignore a stale progress emission from a navigation the user has
        // since left (e.g. a server-library fetch still streaming in the
        // background for a volume that's no longer current).
        if (newUuid !== currentVolumeDataLastUuid) return;
        set(partial);
        // Page structure (and possibly the first image) is available now —
        // let the reader mount instead of showing "loading" until every
        // page has been fetched.
        currentVolumeDataLoadingStore.set(false);
      })
        .then((volumeData) => {
          // Ignore a stale result from a navigation the user has since left
          if (newUuid !== currentVolumeDataLastUuid) return;
          if (volumeData) {
            set(volumeData);
          } else {
            currentVolumeDataErrorStore.set('Volume data not found');
          }
        })
        .catch((error) => {
          console.error('Failed to load current volume data:', error);
          if (newUuid !== currentVolumeDataLastUuid) return;
          currentVolumeDataErrorStore.set(
            error instanceof Error ? error.message : 'Failed to load volume data'
          );
        })
        .finally(() => {
          if (newUuid === currentVolumeDataLastUuid) {
            currentVolumeDataLoadingStore.set(false);
          }
        });
    } else {
      currentVolumeDataLoadingStore.set(false);
    }
  },
  undefined // Initial value
);

// Track last volume UUID to prevent unnecessary data clears/reloads
let currentVolumeDataLastUuid: string | undefined;

/**
 * Japanese character count for current volume.
 * Uses page_char_counts from metadata for O(1) lookup when available.
 */
export const currentVolumeCharacterCount = derived(
  [currentVolume, currentVolumeData],
  ([$currentVolume, $currentVolumeData]) => {
    if (!$currentVolume) return 0;

    // Use pre-calculated cumulative char counts from metadata (v3)
    if ($currentVolume.page_char_counts && $currentVolume.page_char_counts.length > 0) {
      // Last element of cumulative array is the total
      return $currentVolume.page_char_counts[$currentVolume.page_char_counts.length - 1];
    }

    // Fallback: calculate from pages if page_char_counts not available
    if ($currentVolumeData && $currentVolumeData.pages) {
      const japaneseRegex =
        /[○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

      let totalChars = 0;
      for (const page of $currentVolumeData.pages) {
        for (const block of page.blocks) {
          for (const line of block.lines) {
            totalChars += Array.from(line).filter((char) => japaneseRegex.test(char)).length;
          }
        }
      }
      return totalChars;
    }

    return 0;
  }
);
