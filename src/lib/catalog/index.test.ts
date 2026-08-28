import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get, readable, writable } from 'svelte/store';
import { currentView } from '$lib/util/hash-router';
import type { VolumeData, VolumeMetadata } from '$lib/types';

vi.mock('$lib/catalog/db', () => ({
  db: {
    volumes: { toArray: vi.fn().mockResolvedValue([]) },
    volume_ocr: { get: vi.fn().mockResolvedValue(undefined) },
    volume_files: { get: vi.fn().mockResolvedValue(undefined) }
  }
}));

vi.mock('$lib/util/sync/unified-cloud-manager', () => ({
  unifiedCloudManager: {
    cloudFiles: readable(new Map())
  }
}));

const serverLibraryVolumesStore = writable<Record<string, VolumeMetadata>>({});
const loadServerVolumeData =
  vi.fn<
    (
      uuid: string,
      onProgress?: (partial: VolumeData) => void,
      startIndex?: number
    ) => Promise<VolumeData | undefined>
  >();

vi.mock('$lib/catalog/server-library', () => ({
  serverLibraryVolumes: serverLibraryVolumesStore,
  loadServerVolumeData: (
    uuid: string,
    onProgress?: (partial: VolumeData) => void,
    startIndex?: number
  ) => loadServerVolumeData(uuid, onProgress, startIndex)
}));

// Imported after mocks are set up
const { currentVolumeData, currentVolumeDataLoading, currentVolumeDataError } = await import(
  './index'
);

function serverVolume(uuid: string): VolumeMetadata {
  return {
    mokuro_version: '0.2.0',
    series_title: 'Series',
    series_uuid: 's1',
    volume_title: 'Volume',
    volume_uuid: uuid,
    page_count: 1,
    character_count: 0,
    page_char_counts: [0],
    isServerLibrary: true
  };
}

function goToReader(volumeId: string) {
  currentView.set({ type: 'reader', seriesId: 'series', volumeId });
}

describe('currentVolumeData (server-library volumes)', () => {
  beforeEach(() => {
    loadServerVolumeData.mockReset();
    serverLibraryVolumesStore.set({});
    currentView.set({ type: 'catalog' });
  });

  it('shows loading while the fetch is in flight, then resolves the data', async () => {
    let resolveLoad!: (data: VolumeData) => void;
    loadServerVolumeData.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve;
      })
    );
    serverLibraryVolumesStore.set({ v1: serverVolume('v1') });

    const unsubData = currentVolumeData.subscribe(() => {});
    const unsubLoading = currentVolumeDataLoading.subscribe(() => {});

    goToReader('v1');
    await Promise.resolve();

    expect(get(currentVolumeDataLoading)).toBe(true);
    expect(get(currentVolumeData)).toBeUndefined();

    resolveLoad({ volume_uuid: 'v1', pages: [], files: {} });

    await vi.waitFor(() => {
      expect(get(currentVolumeDataLoading)).toBe(false);
    });
    expect(get(currentVolumeData)).toEqual({ volume_uuid: 'v1', pages: [], files: {} });
    expect(get(currentVolumeDataError)).toBeUndefined();

    unsubData();
    unsubLoading();
  });

  it('surfaces a failure via currentVolumeDataError instead of leaving the UI stuck silently', async () => {
    loadServerVolumeData.mockRejectedValue(new Error('NetworkError when attempting to fetch'));
    serverLibraryVolumesStore.set({ v2: serverVolume('v2') });

    const unsub = currentVolumeData.subscribe(() => {});
    goToReader('v2');

    await vi.waitFor(() => {
      expect(get(currentVolumeDataLoading)).toBe(false);
    });

    expect(get(currentVolumeData)).toBeUndefined();
    expect(get(currentVolumeDataError)).toBe('NetworkError when attempting to fetch');

    unsub();
  });

  it('does not re-fetch when the same volume re-emits from an unrelated store update', async () => {
    loadServerVolumeData.mockResolvedValue({ volume_uuid: 'v3', pages: [], files: {} });
    serverLibraryVolumesStore.set({ v3: serverVolume('v3') });

    const unsub = currentVolumeData.subscribe(() => {});
    goToReader('v3');

    await vi.waitFor(() => {
      expect(get(currentVolumeData)).toBeDefined();
    });
    expect(loadServerVolumeData).toHaveBeenCalledTimes(1);

    // Simulate a thumbnail backfill (or any unrelated cause) re-emitting the
    // store with a new object reference for the SAME volume_uuid.
    serverLibraryVolumesStore.set({
      v3: { ...serverVolume('v3'), thumbnail: new File([], 'thumb.jpg') }
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(loadServerVolumeData).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('clears stale data and re-fetches when navigating to a different volume', async () => {
    loadServerVolumeData.mockImplementation(async (uuid: string) => ({
      volume_uuid: uuid,
      pages: [],
      files: {}
    }));
    serverLibraryVolumesStore.set({ v4: serverVolume('v4'), v5: serverVolume('v5') });

    const unsub = currentVolumeData.subscribe(() => {});
    goToReader('v4');
    await vi.waitFor(() => expect(get(currentVolumeData)?.volume_uuid).toBe('v4'));

    goToReader('v5');
    // Old data is cleared synchronously, before the new fetch resolves.
    expect(get(currentVolumeData)).toBeUndefined();

    await vi.waitFor(() => expect(get(currentVolumeData)?.volume_uuid).toBe('v5'));
    expect(loadServerVolumeData).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('shows partial data via onProgress and clears loading as soon as the first partial arrives', async () => {
    let emitProgress!: (partial: VolumeData) => void;
    let resolveLoad!: (data: VolumeData) => void;
    loadServerVolumeData.mockImplementation((_uuid, onProgress) => {
      emitProgress = onProgress!;
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    });
    serverLibraryVolumesStore.set({ v6: serverVolume('v6') });

    const unsub = currentVolumeData.subscribe(() => {});
    goToReader('v6');
    await Promise.resolve();
    expect(get(currentVolumeDataLoading)).toBe(true);

    // First progress emission: page structure known, no images yet — the
    // reader should be able to mount instead of waiting on "loading".
    emitProgress({ volume_uuid: 'v6', pages: [], files: {} });
    await Promise.resolve();
    expect(get(currentVolumeDataLoading)).toBe(false);
    expect(get(currentVolumeData)).toEqual({ volume_uuid: 'v6', pages: [], files: {} });

    // Second progress emission: an image has streamed in.
    const file = new File([], '0001.webp');
    emitProgress({ volume_uuid: 'v6', pages: [], files: { '0001.webp': file } });
    await Promise.resolve();
    expect(get(currentVolumeData)?.files).toEqual({ '0001.webp': file });

    // Final resolution carries the complete set.
    const file2 = new File([], '0002.webp');
    resolveLoad({ volume_uuid: 'v6', pages: [], files: { '0001.webp': file, '0002.webp': file2 } });
    await vi.waitFor(() => {
      expect(Object.keys(get(currentVolumeData)!.files!).sort()).toEqual([
        '0001.webp',
        '0002.webp'
      ]);
    });

    unsub();
  });

  it('ignores a stale onProgress emission from a volume the user has since navigated away from', async () => {
    let emitV7!: (partial: VolumeData) => void;
    loadServerVolumeData.mockImplementation((uuid, onProgress) => {
      if (uuid === 'v7') emitV7 = onProgress!;
      // Neither volume's load ever resolves — only progress emissions matter here.
      return new Promise<VolumeData | undefined>(() => {});
    });
    serverLibraryVolumesStore.set({ v7: serverVolume('v7'), v8: serverVolume('v8') });

    const unsub = currentVolumeData.subscribe(() => {});
    goToReader('v7');
    await Promise.resolve();

    goToReader('v8');
    await Promise.resolve();
    // Navigating away clears data synchronously.
    expect(get(currentVolumeData)).toBeUndefined();

    // A progress emission for the volume we left should be ignored, not
    // resurrect stale data or clear loading for the volume we're now on.
    emitV7({ volume_uuid: 'v7', pages: [], files: {} });
    await Promise.resolve();

    expect(get(currentVolumeData)).toBeUndefined();
    expect(get(currentVolumeDataLoading)).toBe(true);

    unsub();
  });
});
