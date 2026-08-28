import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchMokuroJobs,
  enqueueMokuroJobs,
  cancelMokuroJob,
  getUnprocessedServerVolumes,
  partitionQueueableVolumes,
  volumeToRequest,
  ACTIVE_JOB_STATUSES,
  type MokuroJob,
  type ServerVolumeWithPath
} from './mokuro-processing';
import type { VolumeMetadata } from '$lib/types';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response;
}

function makeJob(overrides: Partial<MokuroJob> = {}): MokuroJob {
  return {
    id: 'job-1',
    library_path: 'Series/Volume 01',
    series_title: 'Series',
    volume_title: 'Volume 01',
    page_count: 10,
    status: 'queued',
    pages_done: 0,
    error: null,
    log_tail: [],
    created_at: '2026-01-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    ...overrides
  };
}

describe('mokuro-processing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetchMokuroJobs', () => {
    it('returns the parsed job list on success', async () => {
      const jobs = [makeJob(), makeJob({ id: 'job-2', status: 'done' })];
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(jobs));

      const result = await fetchMokuroJobs();

      expect(fetch).toHaveBeenCalledWith('/api/mokuro/jobs');
      expect(result).toEqual(jobs);
    });

    it('throws with the response detail message on a non-OK response', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ detail: 'boom' }, false, 500)
      );

      await expect(fetchMokuroJobs()).rejects.toThrow('boom');
    });

    it('falls back to a generic HTTP-status message when the error body has no detail', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({}, false, 502)
      );

      await expect(fetchMokuroJobs()).rejects.toThrow('HTTP 502');
    });
  });

  describe('enqueueMokuroJobs', () => {
    it('POSTs the volume list and returns the created jobs', async () => {
      const created = [makeJob()];
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(created));

      const result = await enqueueMokuroJobs([
        {
          library_path: 'Series/Volume 01',
          series_title: 'Series',
          volume_title: 'Volume 01',
          page_count: 10
        }
      ]);

      expect(fetch).toHaveBeenCalledWith(
        '/api/mokuro/jobs',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body)).toEqual({
        volumes: [
          {
            library_path: 'Series/Volume 01',
            series_title: 'Series',
            volume_title: 'Volume 01',
            page_count: 10
          }
        ]
      });
      expect(result).toEqual(created);
    });

    it('throws on failure instead of returning a partial result', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ detail: 'library_path resolves outside the library root' }, false, 400)
      );

      await expect(
        enqueueMokuroJobs([
          {
            library_path: '../../etc',
            series_title: 'x',
            volume_title: 'y',
            page_count: 1
          }
        ])
      ).rejects.toThrow('outside the library root');
    });
  });

  describe('cancelMokuroJob', () => {
    it('DELETEs the job by id and returns the updated job', async () => {
      const cancelled = makeJob({ status: 'cancelled' });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(cancelled));

      const result = await cancelMokuroJob('job-1');

      expect(fetch).toHaveBeenCalledWith('/api/mokuro/jobs/job-1', { method: 'DELETE' });
      expect(result).toEqual(cancelled);
    });

    it('URL-encodes the job id', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(makeJob()));

      await cancelMokuroJob('weird/id with space');

      expect(fetch).toHaveBeenCalledWith('/api/mokuro/jobs/weird%2Fid%20with%20space', {
        method: 'DELETE'
      });
    });

    it('throws on a 404', async () => {
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ detail: 'Job not found' }, false, 404)
      );

      await expect(cancelMokuroJob('missing')).rejects.toThrow('Job not found');
    });
  });

  describe('ACTIVE_JOB_STATUSES', () => {
    it('treats queued and running as active, everything else as terminal', () => {
      expect(ACTIVE_JOB_STATUSES).toEqual(['queued', 'running']);
      expect(ACTIVE_JOB_STATUSES.includes('done')).toBe(false);
      expect(ACTIVE_JOB_STATUSES.includes('error')).toBe(false);
      expect(ACTIVE_JOB_STATUSES.includes('cancelled')).toBe(false);
    });
  });

  describe('getUnprocessedServerVolumes', () => {
    function makeVolume(overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
      return {
        mokuro_version: '',
        series_title: 'Series B',
        series_uuid: 's1',
        volume_title: 'Volume 01',
        volume_uuid: 'v1',
        page_count: 10,
        character_count: 0,
        page_char_counts: [],
        isServerLibrary: true,
        serverLibraryPath: 'Series B/Volume 01',
        ...overrides
      };
    }

    it('keeps only server-library volumes with no OCR data', () => {
      const volumes = {
        v1: makeVolume({ volume_uuid: 'v1' }), // image-only, eligible
        v2: makeVolume({ volume_uuid: 'v2', mokuro_version: '0.2.0' }), // already processed
        v3: { ...makeVolume({ volume_uuid: 'v3' }), isServerLibrary: false } // not server-library
      };

      const result = getUnprocessedServerVolumes(volumes);

      expect(result.map((v) => v.volume_uuid)).toEqual(['v1']);
    });

    it('excludes a volume with no serverLibraryPath even if it looks unprocessed', () => {
      const volumes = {
        v1: { ...makeVolume({ volume_uuid: 'v1' }), serverLibraryPath: undefined }
      };

      expect(getUnprocessedServerVolumes(volumes)).toEqual([]);
    });

    it('sorts by series title then volume title', () => {
      const volumes = {
        v1: makeVolume({ volume_uuid: 'v1', series_title: 'Zebra', volume_title: 'Volume 01' }),
        v2: makeVolume({ volume_uuid: 'v2', series_title: 'Alpha', volume_title: 'Volume 02' }),
        v3: makeVolume({ volume_uuid: 'v3', series_title: 'Alpha', volume_title: 'Volume 01' })
      };

      const result = getUnprocessedServerVolumes(volumes);

      expect(result.map((v) => v.volume_uuid)).toEqual(['v3', 'v2', 'v1']);
    });
  });

  describe('partitionQueueableVolumes', () => {
    function makeUnprocessed(libraryPath: string): ServerVolumeWithPath {
      return {
        mokuro_version: '',
        series_title: 'Series',
        series_uuid: 's1',
        volume_title: libraryPath,
        volume_uuid: libraryPath,
        page_count: 10,
        character_count: 0,
        page_char_counts: [],
        isServerLibrary: true,
        serverLibraryPath: libraryPath
      };
    }

    it('treats a volume with no job at all as queueable', () => {
      const { queueable } = partitionQueueableVolumes([makeUnprocessed('Series/Vol 01')], []);
      expect(queueable).toHaveLength(1);
    });

    it('excludes a volume that already has a queued or running job', () => {
      const unprocessed = [makeUnprocessed('Series/Vol 01'), makeUnprocessed('Series/Vol 02')];
      const jobs: MokuroJob[] = [
        makeJob({ library_path: 'Series/Vol 01', status: 'queued' }),
        makeJob({ id: 'job-2', library_path: 'Series/Vol 02', status: 'running' })
      ];

      const { queueable, activeJobByPath } = partitionQueueableVolumes(unprocessed, jobs);

      expect(queueable).toEqual([]);
      expect(activeJobByPath.get('Series/Vol 01')?.status).toBe('queued');
      expect(activeJobByPath.get('Series/Vol 02')?.status).toBe('running');
    });

    it('treats a volume whose only job already finished as queueable again', () => {
      const unprocessed = [makeUnprocessed('Series/Vol 01')];
      const jobs: MokuroJob[] = [
        makeJob({ library_path: 'Series/Vol 01', status: 'error' })
      ];

      const { queueable, activeJobByPath } = partitionQueueableVolumes(unprocessed, jobs);

      expect(queueable).toHaveLength(1);
      expect(activeJobByPath.has('Series/Vol 01')).toBe(false);
    });
  });

  describe('volumeToRequest', () => {
    it('maps a server-library volume to the shape the API expects', () => {
      const volume: ServerVolumeWithPath = {
        mokuro_version: '',
        series_title: 'Series',
        series_uuid: 's1',
        volume_title: 'Volume 01',
        volume_uuid: 'v1',
        page_count: 42,
        character_count: 0,
        page_char_counts: [],
        isServerLibrary: true,
        serverLibraryPath: 'Series/Volume 01'
      };

      expect(volumeToRequest(volume)).toEqual({
        library_path: 'Series/Volume 01',
        series_title: 'Series',
        volume_title: 'Volume 01',
        page_count: 42
      });
    });
  });
});
