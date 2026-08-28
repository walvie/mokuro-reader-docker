import asyncio

import pytest

from app.models import JobStatus
from app.queue import JobQueue

from .conftest import make_fake_runner, make_hanging_runner, make_volume


async def wait_until(predicate, timeout: float = 2.0, interval: float = 0.01) -> None:
    elapsed = 0.0
    while not predicate():
        if elapsed >= timeout:
            raise AssertionError(f"condition not met within {timeout}s")
        await asyncio.sleep(interval)
        elapsed += interval


@pytest.fixture
async def queue_with_runner(library_root):
    """Yields (queue, runner_factory) — call runner_factory to swap in a fresh
    fake runner per test, then start the queue."""

    created = {}

    def make(runner):
        created["queue"] = JobQueue(library_root=library_root, runner=runner, poll_interval=0.01)
        created["queue"].start()
        return created["queue"]

    yield make

    if "queue" in created:
        await created["queue"].stop()


async def test_a_queued_job_runs_to_completion_with_full_progress(queue_with_runner):
    runner = make_fake_runner(["0001", "0002", "0003"])
    queue = queue_with_runner(runner)

    job = queue.enqueue(make_volume("Series/Volume 01", page_count=3))
    assert job.status == JobStatus.queued

    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.done)

    finished = queue.get_job(job.id)
    assert finished.pages_done == 3
    assert finished.started_at is not None
    assert finished.finished_at is not None
    assert finished.error is None


async def test_progress_updates_while_the_job_is_still_running(queue_with_runner):
    runner = make_fake_runner(["0001", "0002", "0003", "0004", "0005"], delay=0.05)
    queue = queue_with_runner(runner)

    job = queue.enqueue(make_volume("Series/Volume 01", page_count=5))

    await wait_until(lambda: queue.get_job(job.id).pages_done > 0)
    mid_flight = queue.get_job(job.id)
    assert mid_flight.status == JobStatus.running
    assert 0 < mid_flight.pages_done < 5

    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.done)


async def test_a_failing_job_is_marked_error_with_no_mokuro_file_written(queue_with_runner):
    runner = make_fake_runner(["0001"], exit_code=1, write_mokuro_on_success=False)
    queue = queue_with_runner(runner)

    job = queue.enqueue(make_volume("Series/Volume 01", page_count=1))
    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.error)

    finished = queue.get_job(job.id)
    assert finished.error
    assert "error" in finished.error.lower() or "code" in finished.error.lower()


async def test_jobs_run_strictly_one_at_a_time(queue_with_runner):
    runner = make_fake_runner(["0001", "0002"], delay=0.05)
    queue = queue_with_runner(runner)

    job_a = queue.enqueue(make_volume("Series/Volume 01"))
    job_b = queue.enqueue(make_volume("Series/Volume 02"))

    # Give job A a moment to actually start.
    await wait_until(lambda: queue.get_job(job_a.id).status == JobStatus.running)
    # Job B must still be queued while A is running — no parallel OCR jobs.
    assert queue.get_job(job_b.id).status == JobStatus.queued

    await wait_until(lambda: queue.get_job(job_a.id).status == JobStatus.done)
    await wait_until(lambda: queue.get_job(job_b.id).status == JobStatus.done, timeout=3)


async def test_enqueuing_the_same_volume_twice_while_active_reuses_the_existing_job(
    queue_with_runner,
):
    runner = make_fake_runner(["0001"], delay=0.2)
    queue = queue_with_runner(runner)

    job1 = queue.enqueue(make_volume("Series/Volume 01"))
    job2 = queue.enqueue(make_volume("Series/Volume 01"))

    assert job1.id == job2.id
    assert len(queue.list_jobs()) == 1


async def test_cancelling_a_queued_job_prevents_it_from_ever_running(queue_with_runner):
    runner = make_fake_runner(["0001"], delay=0.2)
    queue = queue_with_runner(runner)

    blocker = queue.enqueue(make_volume("Series/Blocker"))
    target = queue.enqueue(make_volume("Series/Volume 01"))

    cancelled = queue.cancel(target.id)
    assert cancelled.status == JobStatus.cancelled

    await wait_until(lambda: queue.get_job(blocker.id).status == JobStatus.done, timeout=3)
    # Give the worker loop a beat to have (not) picked up the cancelled job.
    await asyncio.sleep(0.05)
    assert queue.get_job(target.id).status == JobStatus.cancelled


async def test_cancelling_a_running_job_stops_it_and_leaves_no_mokuro_file(
    queue_with_runner, library_root
):
    runner = make_hanging_runner()
    queue = queue_with_runner(runner)

    job = queue.enqueue(make_volume("Series/Volume 01"))
    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.running)

    queue.cancel(job.id)
    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.cancelled, timeout=3)

    assert not (library_root / "Series" / "Volume 01.mokuro").exists()


async def test_rescan_callback_fires_only_on_success(library_root):
    calls = {"count": 0}

    async def rescan():
        calls["count"] += 1

    ok_runner = make_fake_runner(["0001"])
    queue = JobQueue(
        library_root=library_root, runner=ok_runner, rescan_callback=rescan, poll_interval=0.01
    )
    queue.start()
    try:
        job = queue.enqueue(make_volume("Series/Volume 01"))
        await wait_until(lambda: queue.get_job(job.id).status == JobStatus.done)
        assert calls["count"] == 1
    finally:
        await queue.stop()


async def test_rescan_callback_does_not_fire_on_failure(library_root):
    calls = {"count": 0}

    async def rescan():
        calls["count"] += 1

    failing_runner = make_fake_runner(["0001"], exit_code=1, write_mokuro_on_success=False)
    queue = JobQueue(
        library_root=library_root,
        runner=failing_runner,
        rescan_callback=rescan,
        poll_interval=0.01,
    )
    queue.start()
    try:
        job = queue.enqueue(make_volume("Series/Volume 01"))
        await wait_until(lambda: queue.get_job(job.id).status == JobStatus.error)
        assert calls["count"] == 0
    finally:
        await queue.stop()


async def test_a_rescan_failure_does_not_flip_a_successful_job_to_error(library_root):
    async def failing_rescan():
        raise RuntimeError("library-server unreachable")

    runner = make_fake_runner(["0001"])
    queue = JobQueue(
        library_root=library_root,
        runner=runner,
        rescan_callback=failing_rescan,
        poll_interval=0.01,
    )
    queue.start()
    try:
        job = queue.enqueue(make_volume("Series/Volume 01"))
        await wait_until(lambda: queue.get_job(job.id).status == JobStatus.done)
        assert queue.get_job(job.id).status == JobStatus.done
    finally:
        await queue.stop()


async def test_enqueuing_a_path_outside_the_library_root_fails_the_job_cleanly(queue_with_runner):
    runner = make_fake_runner(["0001"])
    queue = queue_with_runner(runner)

    job = queue.enqueue(make_volume("../../etc"))
    await wait_until(lambda: queue.get_job(job.id).status == JobStatus.error)
    assert "outside the library root" in queue.get_job(job.id).error


async def test_list_jobs_returns_newest_enqueued_last_in_insertion_order(queue_with_runner):
    runner = make_fake_runner(["0001"], delay=0.2)
    queue = queue_with_runner(runner)

    job1 = queue.enqueue(make_volume("Series/Volume 01"))
    job2 = queue.enqueue(make_volume("Series/Volume 02"))

    ids = [j.id for j in queue.list_jobs()]
    assert ids == [job1.id, job2.id]
