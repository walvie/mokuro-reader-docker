"""
The real mokuro invocation. Kept separate from queue.py so tests can inject
a fake runner and exercise the queue's orchestration (status transitions,
progress polling, cancellation, log capture) without actually running
mokuro's OCR pipeline.
"""

import asyncio
from pathlib import Path
from typing import Callable, Protocol

OnLine = Callable[[str], None]


class Runner(Protocol):
    async def __call__(self, volume_dir: Path, on_line: OnLine) -> int:
        """Run mokuro against volume_dir, forwarding each output line to on_line, and return the exit code."""
        ...


async def run_mokuro(volume_dir: Path, on_line: OnLine) -> int:
    # --disable_confirmation: we already gate this behind our own UI, mokuro's
    #   interactive y/n prompt would just hang the subprocess forever.
    # --force_cpu: this deployment is configured CPU-only (see README).
    # --ignore_errors: one bad page shouldn't abort the whole volume — we
    #   still surface the failure via mokuro's own error output.
    argv = [
        "python3",
        "-m",
        "mokuro",
        str(volume_dir),
        "--disable_confirmation",
        "--force_cpu",
        "--ignore_errors",
    ]

    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    try:
        assert process.stdout is not None
        while True:
            raw_line = await process.stdout.readline()
            if not raw_line:
                break
            on_line(raw_line.decode("utf-8", errors="replace").rstrip("\n"))

        return await process.wait()
    except asyncio.CancelledError:
        # Cancelling the asyncio Task wrapping this coroutine does NOT kill
        # the OS subprocess on its own — do that explicitly, or a cancelled
        # job leaves an orphaned mokuro process still burning CPU.
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        raise
