import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/catalog/thumbnails', () => ({
  generateThumbnail: vi.fn().mockResolvedValue({
    file: new File([], 'thumb.jpg'),
    width: 250,
    height: 350
  })
}));

import {
  serverLibraryVolumes,
  refreshServerLibrary,
  loadServerVolumeData,
  fetchServerVolumeOcr,
  rescanServerLibrary
} from './server-library';
import { generateThumbnail } from '$lib/catalog/thumbnails';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }))
  } as unknown as Response;
}

describe('server-library', () => {
  beforeEach(() => {
    // clearAllMocks (not restoreAllMocks): the latter would wipe out the
    // mockResolvedValue set on generateThumbnail's vi.mock() factory above,
    // since a factory-created vi.fn() has no "original" implementation to
    // restore to.
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('refreshServerLibrary', () => {
    it('populates serverLibraryVolumes from /api/volumes, flagged isServerLibrary', async () => {
      const summary = {
        volume_uuid: 'v1',
        series_uuid: 's1',
        series_title: 'Houseki no Kuni',
        volume_title: 'Volume 02',
        mokuro_version: '0.2.0',
        page_count: 2,
        character_count: 10,
        page_char_counts: [5, 10],
        cover_path: null
      };
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse([summary]));

      await refreshServerLibrary();

      const volumes = get(serverLibraryVolumes);
      expect(volumes['v1']).toMatchObject({
        volume_uuid: 'v1',
        series_title: 'Houseki no Kuni',
        volume_title: 'Volume 02',
        isServerLibrary: true
      });
    });

    it('leaves the store empty (without throwing) when library-server is unreachable', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));

      await expect(refreshServerLibrary()).resolves.toBeUndefined();
      expect(get(serverLibraryVolumes)).toEqual({});
    });

    it('leaves the store empty when the endpoint responds with a non-OK status', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(null, false, 500)
      );

      await refreshServerLibrary();
      expect(get(serverLibraryVolumes)).toEqual({});
    });

    it('backfills a thumbnail asynchronously for volumes with a cover_path', async () => {
      const summary = {
        volume_uuid: 'v2',
        series_uuid: 's2',
        series_title: 'Series',
        volume_title: 'Volume 01',
        mokuro_version: '0.2.0',
        page_count: 1,
        character_count: 0,
        page_char_counts: [0],
        cover_path: '0001.webp'
      };
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse([summary]));

      await refreshServerLibrary();
      // The thumbnail backfill is intentionally fire-and-forget (doesn't
      // block the initial catalog population), so poll for it to land.
      await vi.waitFor(() => {
        expect(get(serverLibraryVolumes)['v2'].thumbnail).toBeInstanceOf(File);
      });

      expect(generateThumbnail).toHaveBeenCalled();
      const volumes = get(serverLibraryVolumes);
      expect(volumes['v2'].thumbnail_width).toBe(250);
    });
  });

  describe('loadServerVolumeData', () => {
    it('fetches OCR data and every referenced page image, keyed by img_path', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/volumes/v1') {
          return Promise.resolve(
            jsonResponse({
              volume_uuid: 'v1',
              pages: [
                { img_path: '0001.webp', img_width: 10, img_height: 10, blocks: [] },
                { img_path: '0002.webp', img_width: 10, img_height: 10, blocks: [] }
              ]
            })
          );
        }
        return Promise.resolve(jsonResponse({}));
      });

      const data = await loadServerVolumeData('v1');

      expect(data).toBeDefined();
      expect(data!.pages).toHaveLength(2);
      expect(Object.keys(data!.files!).sort()).toEqual(['0001.webp', '0002.webp']);
      expect(data!.files!['0001.webp']).toBeInstanceOf(File);
    });

    it('returns undefined when the volume is not found', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ error: 'Volume not found' }, false, 404)
      );

      const data = await loadServerVolumeData('missing');
      expect(data).toBeUndefined();
    });

    it('drops a page whose image request fails, rather than throwing', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/volumes/v1') {
          return Promise.resolve(
            jsonResponse({
              volume_uuid: 'v1',
              pages: [{ img_path: '0001.webp', img_width: 10, img_height: 10, blocks: [] }]
            })
          );
        }
        return Promise.resolve(jsonResponse({ error: 'not found' }, false, 404));
      });

      const data = await loadServerVolumeData('v1');
      expect(data).toBeDefined();
      expect(data!.files).toEqual({});
    });
  });

  describe('fetchServerVolumeOcr', () => {
    it('returns the parsed OCR payload on success', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ volume_uuid: 'v1', pages: [] })
      );

      const ocr = await fetchServerVolumeOcr('v1');
      expect(ocr).toEqual({ volume_uuid: 'v1', pages: [] });
    });

    it('returns undefined instead of throwing on a network error', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

      const ocr = await fetchServerVolumeOcr('v1');
      expect(ocr).toBeUndefined();
    });
  });

  describe('rescanServerLibrary', () => {
    it('POSTs /api/rescan, then reloads serverLibraryVolumes from the fresh scan', async () => {
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch.mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/rescan' && init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ ok: true, volumeCount: 1 }));
        }
        if (url === '/api/volumes') {
          return Promise.resolve(
            jsonResponse([
              {
                volume_uuid: 'v3',
                series_uuid: 's3',
                series_title: 'Series',
                volume_title: 'Volume 01',
                mokuro_version: '0.2.0',
                page_count: 1,
                character_count: 0,
                page_char_counts: [0],
                cover_path: null
              }
            ])
          );
        }
        return Promise.resolve(jsonResponse({}));
      });

      const result = await rescanServerLibrary();

      expect(result).toEqual({ volumeCount: 1 });
      expect(mockFetch).toHaveBeenCalledWith('/api/rescan', { method: 'POST' });
      expect(get(serverLibraryVolumes)['v3']).toMatchObject({ volume_title: 'Volume 01' });
    });

    it('throws when the rescan endpoint responds with a non-OK status', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse(null, false, 500)
      );

      await expect(rescanServerLibrary()).rejects.toThrow('HTTP 500');
    });

    it('propagates a network error instead of silently swallowing it', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('library-server unreachable')
      );

      await expect(rescanServerLibrary()).rejects.toThrow('library-server unreachable');
    });
  });
});
