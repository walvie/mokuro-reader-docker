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
const loadServerVolumeData = vi.fn<(uuid: string) => Promise<VolumeData | undefined>>();

vi.mock('$lib/catalog/server-library', () => ({
  serverLibraryVolumes: serverLibraryVolumesStore,
  loadServerVolumeData: (uuid: string) => loadServerVolumeData(uuid)
}));

// Imported after mocks are set up
const {
  currentVolumeData,
  currentVolumeDataLoading,
  currentVolumeDataError
} = await import('./index');

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
});
