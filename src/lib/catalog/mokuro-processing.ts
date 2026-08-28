/**
 * Client for the mokuro-worker sidecar (see /mokuro-worker) — runs mokuro
 * (OCR) against server-library volumes that don't have it yet. Proxied by
 * nginx at /api/mokuro/*, same-origin, same pattern as server-library.ts.
 */

import type { VolumeMetadata } from '$lib/types';

export type MokuroJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface MokuroJob {
  id: string;
  library_path: string;
  series_title: string;
  volume_title: string;
  page_count: number;
  status: MokuroJobStatus;
  pages_done: number;
  error: string | null;
  log_tail: string[];
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface VolumeToProcess {
  library_path: string;
  series_title: string;
  volume_title: string;
  page_count: number;
}

export const ACTIVE_JOB_STATUSES: readonly MokuroJobStatus[] = ['queued', 'running'];

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === 'string') return body.detail;
  } catch {
    // fall through to the generic message below
  }
  return `HTTP ${res.status}`;
}

export async function fetchMokuroJobs(): Promise<MokuroJob[]> {
  const res = await fetch('/api/mokuro/jobs');
  if (!res.ok) throw new Error(await parseErrorBody(res));
  return res.json();
}

export async function enqueueMokuroJobs(volumes: VolumeToProcess[]): Promise<MokuroJob[]> {
  const res = await fetch('/api/mokuro/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volumes })
  });
  if (!res.ok) throw new Error(await parseErrorBody(res));
  return res.json();
}

export async function cancelMokuroJob(id: string): Promise<MokuroJob> {
  const res = await fetch(`/api/mokuro/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await parseErrorBody(res));
  return res.json();
}

export type ServerVolumeWithPath = VolumeMetadata & { serverLibraryPath: string };

/**
 * Server-library volumes with no OCR data yet, sorted for stable display.
 * Excludes anything without a serverLibraryPath (shouldn't happen in
 * practice — every server-library volume gets one — but mokuro-worker has
 * nothing to run against without it).
 */
export function getUnprocessedServerVolumes(
  volumes: Record<string, VolumeMetadata>
): ServerVolumeWithPath[] {
  return Object.values(volumes)
    .filter(
      (v): v is ServerVolumeWithPath =>
        v.isServerLibrary === true && v.mokuro_version === '' && !!v.serverLibraryPath
    )
    .sort((a, b) =>
      `${a.series_title} ${a.volume_title}`.localeCompare(`${b.series_title} ${b.volume_title}`)
    );
}

/**
 * Splits unprocessed volumes into those safe to enqueue vs. those that
 * already have an active (queued or running) job, so "Process all" and
 * per-row buttons don't double-enqueue a volume that's already in flight.
 */
export function partitionQueueableVolumes(
  unprocessed: ServerVolumeWithPath[],
  jobs: MokuroJob[]
): { queueable: ServerVolumeWithPath[]; activeJobByPath: Map<string, MokuroJob> } {
  const activeJobByPath = new Map<string, MokuroJob>();
  for (const job of jobs) {
    if (ACTIVE_JOB_STATUSES.includes(job.status)) {
      activeJobByPath.set(job.library_path, job);
    }
  }
  const queueable = unprocessed.filter((v) => !activeJobByPath.has(v.serverLibraryPath));
  return { queueable, activeJobByPath };
}

export function volumeToRequest(v: ServerVolumeWithPath): VolumeToProcess {
  return {
    library_path: v.serverLibraryPath,
    series_title: v.series_title,
    volume_title: v.volume_title,
    page_count: v.page_count
  };
}
