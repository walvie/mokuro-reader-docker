/**
 * Self-hosted server library integration.
 *
 * Optional (Docker-only) feature: a sidecar "library-server" container (see
 * /server) serves a mokuro manga library directly from a mounted host
 * directory. This module talks to it over `/api/*` (reverse-proxied by
 * nginx onto the same origin, see docker/nginx.conf) and exposes:
 *
 * - `serverLibraryVolumes`: a store of VolumeMetadata for the catalog/series
 *   views to merge in alongside Dexie-backed and cloud-placeholder volumes.
 * - `loadServerVolumeData`: fetches a volume's OCR + page images on demand
 *   for the reader, returning the same VolumeData shape `loadCurrentVolumeData`
 *   produces for local volumes — nothing downstream (ImageCache, MangaPage,
 *   the scroll readers) needs to know the difference.
 *
 * Nothing here is written to IndexedDB: page images live only in memory for
 * as long as a volume is open, and are released when the reader navigates
 * away. If the library-server isn't running (or isn't configured), every
 * call here just degrades to "no server volumes" rather than erroring.
 */

import { writable, type Readable } from 'svelte/store';
import type { VolumeData, VolumeMetadata } from '$lib/types';
import { generateThumbnail, type ThumbnailResult } from '$lib/catalog/thumbnails';

interface ServerVolumeSummary {
  volume_uuid: string;
  series_uuid: string;
  series_title: string;
  volume_title: string;
  mokuro_version: string;
  page_count: number;
  character_count: number;
  page_char_counts: number[];
  missing_pages?: number;
  missing_page_paths?: string[];
  spine_width?: number;
  cover_path: string | null;
}

interface ServerVolumeOcr {
  volume_uuid: string;
  pages: VolumeData['pages'];
}

const store = writable<Record<string, VolumeMetadata>>({});

/** Volumes served by the self-hosted library-server, keyed by volume_uuid. */
export const serverLibraryVolumes: Readable<Record<string, VolumeMetadata>> = store;

let initialized = false;
let refreshInFlight: Promise<void> | null = null;

function pageUrl(volumeUuid: string, imgPath: string): string {
  const encodedPath = imgPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/volumes/${encodeURIComponent(volumeUuid)}/pages/${encodedPath}`;
}

function toVolumeMetadata(summary: ServerVolumeSummary): VolumeMetadata {
  return {
    mokuro_version: summary.mokuro_version,
    series_title: summary.series_title,
    series_uuid: summary.series_uuid,
    volume_title: summary.volume_title,
    volume_uuid: summary.volume_uuid,
    page_count: summary.page_count,
    character_count: summary.character_count,
    page_char_counts: summary.page_char_counts,
    missing_pages: summary.missing_pages,
    missing_page_paths: summary.missing_page_paths,
    spine_width: summary.spine_width,
    isServerLibrary: true
  };
}

/**
 * Fetch the current volume list from the library-server and populate
 * `serverLibraryVolumes`. Safe to call even when the feature isn't
 * configured/running — logs once and leaves the store empty.
 *
 * Coalesces concurrent calls so repeated triggers (app init + a manual
 * refresh button, for instance) only cause one network round trip.
 */
export function refreshServerLibrary(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let summaries: ServerVolumeSummary[];
    try {
      const res = await fetch('/api/volumes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      summaries = await res.json();
    } catch (error) {
      // Expected whenever the library-server sidecar isn't deployed —
      // not every self-hoster uses this feature.
      console.debug('[server-library] library-server not reachable, skipping:', error);
      store.set({});
      return;
    }

    const next: Record<string, VolumeMetadata> = {};
    for (const summary of summaries) {
      next[summary.volume_uuid] = toVolumeMetadata(summary);
    }
    store.set(next);

    void backfillThumbnails(summaries);
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

/** Call once at app startup. Subsequent calls are no-ops (use refreshServerLibrary() to re-poll). */
export function initServerLibrary(): void {
  if (initialized) return;
  initialized = true;
  void refreshServerLibrary();
}

/**
 * Trigger a fresh directory scan on the library-server (POST /api/rescan —
 * picks up manga added/removed on disk since the last scan/startup), then
 * reload `serverLibraryVolumes` from the result. Used by the "Refresh
 * library" button in Catalog settings.
 *
 * Throws on failure (unreachable server, non-OK response) so the caller can
 * surface it — unlike refreshServerLibrary(), this is a deliberate user
 * action, so silently doing nothing would be confusing.
 */
export async function rescanServerLibrary(): Promise<{ volumeCount: number }> {
  const res = await fetch('/api/rescan', { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Rescan failed: HTTP ${res.status}`);
  }
  const result: { ok: boolean; volumeCount: number } = await res.json();

  await refreshServerLibrary();

  return { volumeCount: result.volumeCount };
}

const THUMBNAIL_CONCURRENCY = 4;

async function backfillThumbnails(summaries: ServerVolumeSummary[]): Promise<void> {
  const queue = summaries.filter((s) => s.cover_path);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < queue.length) {
      const summary = queue[index++];
      const result = await fetchCoverThumbnail(summary);
      if (!result) continue;
      store.update((current) => {
        const existing = current[summary.volume_uuid];
        if (!existing) return current; // volume disappeared from a concurrent refresh
        return {
          ...current,
          [summary.volume_uuid]: {
            ...existing,
            thumbnail: result.file,
            thumbnail_width: result.width,
            thumbnail_height: result.height
          }
        };
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, queue.length) }, () => worker())
  );
}

async function fetchCoverThumbnail(summary: ServerVolumeSummary): Promise<ThumbnailResult | null> {
  if (!summary.cover_path) return null;
  try {
    const res = await fetch(pageUrl(summary.volume_uuid, summary.cover_path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], summary.cover_path.split('/').pop() || 'cover', {
      type: blob.type
    });
    return await generateThumbnail(file);
  } catch (error) {
    console.warn(`[server-library] failed to fetch cover for ${summary.volume_title}:`, error);
    return null;
  }
}

const PAGE_FETCH_CONCURRENCY = 6;

async function fetchPage(volumeUuid: string, imgPath: string): Promise<File | null> {
  try {
    const res = await fetch(pageUrl(volumeUuid, imgPath));
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], imgPath.split('/').pop() || imgPath, { type: blob.type });
  } catch (error) {
    console.warn(`[server-library] failed to fetch page ${imgPath}:`, error);
    return null;
  }
}

/**
 * Load a server-library volume's OCR data and page images for the reader.
 * Fetches every page image up front (bounded concurrency) into in-memory
 * File objects — nothing touches IndexedDB. For a very large volume this
 * means a bulk fetch rather than true per-page streaming, but it lets the
 * volume plug into the existing reader pipeline (ImageCache et al.)
 * completely unmodified.
 */
export async function loadServerVolumeData(volumeUuid: string): Promise<VolumeData | undefined> {
  const ocr = await fetchServerVolumeOcr(volumeUuid);
  if (!ocr) return undefined;

  const files: Record<string, File> = {};
  const imgPaths = ocr.pages.map((p) => p.img_path);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < imgPaths.length) {
      const imgPath = imgPaths[cursor++];
      const file = await fetchPage(volumeUuid, imgPath);
      if (file) files[imgPath] = file;
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PAGE_FETCH_CONCURRENCY, imgPaths.length) }, () => worker())
  );

  return { volume_uuid: volumeUuid, pages: ocr.pages, files };
}

/**
 * Fetch just a server-library volume's page/OCR data (no images) — used for
 * text-only views where fetching every page image would be wasteful.
 */
export async function fetchServerVolumeOcr(
  volumeUuid: string
): Promise<ServerVolumeOcr | undefined> {
  try {
    const res = await fetch(`/api/volumes/${encodeURIComponent(volumeUuid)}`);
    if (!res.ok) {
      console.error(`[server-library] failed to load volume ${volumeUuid}: HTTP ${res.status}`);
      return undefined;
    }
    return await res.json();
  } catch (error) {
    console.error(`[server-library] failed to load volume ${volumeUuid}:`, error);
    return undefined;
  }
}
