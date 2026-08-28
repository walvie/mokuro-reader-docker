<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Button, Badge, Card, Alert, Spinner, Progressbar } from 'flowbite-svelte';
  import { serverLibraryVolumes, refreshServerLibrary } from '$lib/catalog/server-library';
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
  } from '$lib/catalog/mokuro-processing';

  const POLL_INTERVAL_MS = 2000;

  let jobs = $state<MokuroJob[]>([]);
  let initialLoading = $state(true);
  let loadError = $state('');
  let processingAll = $state(false);
  let processingLibraryPaths = $state<Set<string>>(new Set());
  let expandedLogJobId = $state<string | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let previousTerminalIds = new Set<string>();

  let unprocessedVolumes = $derived(getUnprocessedServerVolumes($serverLibraryVolumes));
  let queueablePartition = $derived(partitionQueueableVolumes(unprocessedVolumes, jobs));
  let queueableVolumes = $derived(queueablePartition.queueable);
  let jobByLibraryPath = $derived(queueablePartition.activeJobByPath);

  function isTerminal(status: MokuroJob['status']): boolean {
    return status === 'done' || status === 'error' || status === 'cancelled';
  }

  async function loadJobs(): Promise<void> {
    try {
      const newJobs = await fetchMokuroJobs();
      const nowTerminalIds = new Set(newJobs.filter((j) => isTerminal(j.status)).map((j) => j.id));
      const newlyTerminal = [...nowTerminalIds].some((id) => !previousTerminalIds.has(id));

      jobs = newJobs;
      previousTerminalIds = nowTerminalIds;
      loadError = '';

      // A volume just finished processing (or failed/was cancelled) — refresh
      // the server library so a successful one drops out of "Needs processing".
      if (newlyTerminal) {
        void refreshServerLibrary();
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load the processing queue';
    } finally {
      initialLoading = false;
    }
  }

  onMount(() => {
    void loadJobs();
    pollTimer = setInterval(loadJobs, POLL_INTERVAL_MS);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  async function processVolume(v: ServerVolumeWithPath): Promise<void> {
    processingLibraryPaths = new Set(processingLibraryPaths).add(v.serverLibraryPath);
    try {
      await enqueueMokuroJobs([volumeToRequest(v)]);
      await loadJobs();
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to start processing';
    } finally {
      const next = new Set(processingLibraryPaths);
      next.delete(v.serverLibraryPath);
      processingLibraryPaths = next;
    }
  }

  async function processAll(): Promise<void> {
    if (queueableVolumes.length === 0) return;
    processingAll = true;
    try {
      await enqueueMokuroJobs(queueableVolumes.map(volumeToRequest));
      await loadJobs();
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to start processing';
    } finally {
      processingAll = false;
    }
  }

  async function onCancel(jobId: string): Promise<void> {
    try {
      await cancelMokuroJob(jobId);
      await loadJobs();
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to cancel the job';
    }
  }

  function statusColor(status: MokuroJob['status']) {
    switch (status) {
      case 'queued':
        return 'gray';
      case 'running':
        return 'blue';
      case 'done':
        return 'green';
      case 'error':
        return 'red';
      case 'cancelled':
        return 'yellow';
    }
  }

  function formatDuration(job: MokuroJob): string {
    if (!job.started_at) return '';
    const end = job.finished_at ? new Date(job.finished_at) : new Date();
    const totalSeconds = Math.max(
      0,
      Math.round((end.getTime() - new Date(job.started_at).getTime()) / 1000)
    );
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
</script>

<div class="container mx-auto max-w-4xl px-4 py-8">
  <h1 class="mb-2 text-3xl font-bold">Mokuro Processing</h1>
  <p class="mb-6 text-sm text-gray-500 dark:text-gray-400">
    Runs OCR (<a
      href="https://github.com/kha-white/mokuro"
      target="_blank"
      rel="noreferrer"
      class="underline">mokuro</a
    >) against volumes in your server library that don't have it yet. Jobs run one at a time.
    Only volumes found via the server library are eligible here — see Catalog settings for
    volumes imported locally.
  </p>

  {#if loadError}
    <Alert color="red" class="mb-4">{loadError}</Alert>
  {/if}

  {#if initialLoading}
    <div class="flex justify-center py-12">
      <Spinner />
    </div>
  {:else}
    <Card size="xl" class="mb-6 w-full max-w-none">
      <div class="mb-3 flex items-center justify-between gap-4">
        <h2 class="text-xl font-semibold">Needs processing ({unprocessedVolumes.length})</h2>
        <Button
          onclick={processAll}
          disabled={queueableVolumes.length === 0 || processingAll}
          color="blue"
        >
          {processingAll ? 'Starting…' : `Process all (${queueableVolumes.length})`}
        </Button>
      </div>

      {#if unprocessedVolumes.length === 0}
        <p class="text-gray-500 dark:text-gray-400">
          Every volume in your server library already has OCR data.
        </p>
      {:else}
        <div class="flex flex-col divide-y divide-gray-200 dark:divide-gray-700">
          {#each unprocessedVolumes as volume (volume.volume_uuid)}
            {@const job = jobByLibraryPath.get(volume.serverLibraryPath)}
            {@const isStarting = processingLibraryPaths.has(volume.serverLibraryPath)}
            <div class="flex items-center justify-between gap-4 py-3">
              <div class="min-w-0">
                <p class="truncate font-medium">{volume.series_title} — {volume.volume_title}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{volume.page_count} pages</p>
              </div>
              {#if job && ACTIVE_JOB_STATUSES.includes(job.status)}
                <Badge color={statusColor(job.status)} class="relative z-10 shrink-0"
                  >{job.status}</Badge
                >
              {:else}
                <Button
                  size="sm"
                  class="relative z-10 shrink-0"
                  disabled={isStarting}
                  onclick={() => processVolume(volume)}
                >
                  {isStarting ? 'Starting…' : 'Process'}
                </Button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Card>

    <Card size="xl" class="w-full max-w-none">
      <h2 class="mb-3 text-xl font-semibold">Queue</h2>
      {#if jobs.length === 0}
        <p class="text-gray-500 dark:text-gray-400">No processing jobs yet.</p>
      {:else}
        <div class="flex flex-col divide-y divide-gray-200 dark:divide-gray-700">
          {#each jobs as job (job.id)}
            <div class="py-3">
              <div class="flex items-center justify-between gap-4">
                <div class="min-w-0">
                  <p class="truncate font-medium">{job.series_title} — {job.volume_title}</p>
                  <p class="text-xs text-gray-500 dark:text-gray-400">
                    {job.pages_done}/{job.page_count} pages{#if job.started_at}
                      · {formatDuration(job)}{/if}
                  </p>
                </div>
                <div class="relative z-10 flex shrink-0 items-center gap-2">
                  <Badge color={statusColor(job.status)}>{job.status}</Badge>
                  {#if ACTIVE_JOB_STATUSES.includes(job.status)}
                    <Button size="sm" color="red" outline onclick={() => onCancel(job.id)}>
                      Cancel
                    </Button>
                  {/if}
                </div>
              </div>

              {#if job.status === 'running'}
                <Progressbar
                  progress={String(
                    job.page_count > 0 ? Math.round((job.pages_done / job.page_count) * 100) : 0
                  )}
                  class="mt-2"
                />
              {/if}

              {#if job.status === 'error'}
                <button
                  class="relative z-10 mt-1 text-xs text-red-500 underline hover:text-red-600"
                  onclick={() => (expandedLogJobId = expandedLogJobId === job.id ? null : job.id)}
                >
                  {expandedLogJobId === job.id ? 'Hide log' : 'Show log'}
                </button>
                {#if expandedLogJobId === job.id}
                  <pre
                    class="mt-1 max-h-64 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-200">{job.log_tail.join(
                      '\n'
                    ) || job.error}</pre>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  {/if}
</div>
