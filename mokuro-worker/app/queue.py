"""
Sequential job queue: one mokuro invocation at a time (OCR is CPU/memory
heavy — see README for why this deployment doesn't run jobs in parallel).

Progress is tracked by polling the filesystem (count of per-page JSON files
mokuro writes into its _ocr cache dir as it works — see paths.py) rather
than by parsing mokuro's stdout, since that's a tqdm progress bar that
doesn't emit clean per-page lines. This also keeps the queue's correctness
independent of the runner's stdout formatting.
"""

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Awaitable, Callable, Optional

from . import paths
from .config import LOG_TAIL_MAX_LINES, PROGRESS_POLL_INTERVAL_SECONDS
from .models import Job, JobStatus, VolumeRequest, now_iso
from .runner import Runner, run_mokuro

logger = logging.getLogger("mokuro_worker.queue")

RescanCallback = Callable[[], Awaitable[None]]

ACTIVE_STATUSES = (JobStatus.queued, JobStatus.running)


class JobQueue:
    def __init__(
        self,
        library_root: Path,
        runner: Runner = run_mokuro,
        rescan_callback: Optional[RescanCallback] = None,
        poll_interval: float = PROGRESS_POLL_INTERVAL_SECONDS,
    ):
        self._library_root = library_root
        self._runner = runner
        self._rescan_callback = rescan_callback
        self._poll_interval = poll_interval

        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._pending: "asyncio.Queue[str]" = asyncio.Queue()
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._worker_task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._worker_loop())

    async def stop(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
            self._worker_task = None

    def list_jobs(self) -> list[Job]:
        return [self._jobs[jid] for jid in self._order]

    def get_job(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def enqueue(self, volume: VolumeRequest) -> Job:
        # Idempotent: a volume already queued or running is not double-enqueued
        # (covers double-clicks and "process all" being clicked more than once).
        for jid in self._order:
            existing = self._jobs[jid]
            if existing.library_path == volume.library_path and existing.status in ACTIVE_STATUSES:
                return existing

        job = Job(
            id=str(uuid.uuid4()),
            library_path=volume.library_path,
            series_title=volume.series_title,
            volume_title=volume.volume_title,
            page_count=volume.page_count,
            status=JobStatus.queued,
        )
        self._jobs[job.id] = job
        self._order.append(job.id)
        self._pending.put_nowait(job.id)
        return job

    def cancel(self, job_id: str) -> Optional[Job]:
        job = self._jobs.get(job_id)
        if job is None:
            return None

        if job.status == JobStatus.queued:
            job.status = JobStatus.cancelled
            job.finished_at = now_iso()
        elif job.status == JobStatus.running:
            event = self._cancel_events.get(job_id)
            if event is not None:
                event.set()
        return job

    async def _worker_loop(self) -> None:
        while True:
            job_id = await self._pending.get()
            job = self._jobs.get(job_id)
            if job is None or job.status != JobStatus.queued:
                # Cancelled while queued (or otherwise gone) — nothing to run.
                continue
            await self._run_job(job)

    async def _run_job(self, job: Job) -> None:
        job.status = JobStatus.running
        job.started_at = now_iso()

        try:
            volume_dir = paths.resolve_volume_dir(self._library_root, job.library_path)
        except Exception as exc:
            job.status = JobStatus.error
            job.error = str(exc)
            job.finished_at = now_iso()
            return

        def on_line(line: str) -> None:
            job.log_tail.append(line)
            overflow = len(job.log_tail) - LOG_TAIL_MAX_LINES
            if overflow > 0:
                del job.log_tail[:overflow]

        cancel_event = asyncio.Event()
        self._cancel_events[job.id] = cancel_event
        progress_task = asyncio.create_task(self._poll_progress(job, volume_dir))

        try:
            run_task = asyncio.create_task(self._runner(volume_dir, on_line))
            cancel_wait_task = asyncio.create_task(cancel_event.wait())
            done, _pending = await asyncio.wait(
                {run_task, cancel_wait_task}, return_when=asyncio.FIRST_COMPLETED
            )

            if run_task in done:
                cancel_wait_task.cancel()
                await _drain(cancel_wait_task)
                self._finish_from_exit_code(job, volume_dir, run_task.result())
            else:
                run_task.cancel()
                await _drain(run_task)
                job.status = JobStatus.cancelled
        except Exception as exc:
            logger.exception("Unexpected error running job %s", job.id)
            job.status = JobStatus.error
            job.error = str(exc)
        finally:
            del self._cancel_events[job.id]
            progress_task.cancel()
            await _drain(progress_task)
            job.finished_at = now_iso()

        if job.status == JobStatus.done and self._rescan_callback is not None:
            try:
                await self._rescan_callback()
            except Exception:
                logger.exception(
                    "Job %s finished but triggering a library-server rescan failed "
                    "(the volume was still processed correctly on disk)",
                    job.id,
                )

    def _finish_from_exit_code(self, job: Job, volume_dir: Path, exit_code: int) -> None:
        mokuro_path = paths.mokuro_output_path(volume_dir)
        if exit_code == 0 and mokuro_path.is_file():
            job.status = JobStatus.done
            job.pages_done = job.page_count
        else:
            job.status = JobStatus.error
            recent_log = "\n".join(job.log_tail[-5:])
            job.error = recent_log or f"mokuro exited with code {exit_code}"

    async def _poll_progress(self, job: Job, volume_dir: Path) -> None:
        while True:
            job.pages_done = min(paths.count_cached_pages(volume_dir), job.page_count)
            await asyncio.sleep(self._poll_interval)


async def _drain(task: "asyncio.Task") -> None:
    """Await a task we just cancelled, swallowing the CancelledError it raises."""
    try:
        await task
    except asyncio.CancelledError:
        pass
