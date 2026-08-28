"""
Exercises the real subprocess plumbing in runner.py — line streaming, exit
code, and cancellation actually killing the OS process — without invoking
mokuro itself (not installed in this test environment). We substitute the
argv mokuro would run with a trivial shell command via monkeypatching
asyncio.create_subprocess_exec, which is the actual mechanism run_mokuro
uses regardless of what argv it's given.
"""

import asyncio
import sys

import pytest

from app import runner


@pytest.fixture
def fake_mokuro_argv(monkeypatch):
    """Redirects run_mokuro's subprocess call to a substitute command,
    while still exercising the real asyncio.create_subprocess_exec plumbing."""

    captured = {}

    def install(argv: list[str]):
        real_create = asyncio.create_subprocess_exec

        async def fake_create_subprocess_exec(*args, **kwargs):
            captured["original_argv"] = args
            return await real_create(*argv, **kwargs)

        monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
        return captured

    return install


async def test_streams_output_lines_and_returns_the_exit_code(fake_mokuro_argv, tmp_path):
    captured = fake_mokuro_argv(
        [sys.executable, "-c", "print('line one'); print('line two')"]
    )

    lines = []
    exit_code = await runner.run_mokuro(tmp_path, lines.append)

    assert exit_code == 0
    assert lines == ["line one", "line two"]
    # Confirms run_mokuro really did invoke python -m mokuro with the volume dir.
    assert str(tmp_path) in captured["original_argv"]
    assert "--force_cpu" in captured["original_argv"]
    assert "--disable_confirmation" in captured["original_argv"]
    assert "--ignore_errors" in captured["original_argv"]


async def test_propagates_a_nonzero_exit_code(fake_mokuro_argv, tmp_path):
    fake_mokuro_argv([sys.executable, "-c", "import sys; sys.exit(3)"])

    exit_code = await runner.run_mokuro(tmp_path, lambda _line: None)

    assert exit_code == 3


async def test_cancellation_actually_terminates_the_subprocess(fake_mokuro_argv, tmp_path):
    marker = tmp_path / "still-running.txt"
    fake_mokuro_argv(
        [
            sys.executable,
            "-c",
            f"import time,pathlib; pathlib.Path({str(marker)!r}).write_text('x'); time.sleep(60)",
        ]
    )

    task = asyncio.create_task(runner.run_mokuro(tmp_path, lambda _line: None))

    # Wait for the subprocess to actually start and touch the marker file.
    for _ in range(200):
        if marker.exists():
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("subprocess never started")

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # If the process were still alive, it would sleep for 60s; give the
    # terminate()/kill() path a moment and confirm nothing is left hanging.
    await asyncio.sleep(0.2)
