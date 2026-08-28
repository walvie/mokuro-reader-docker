import asyncio
from pathlib import Path
from typing import Callable

import pytest

from app import paths
from app.models import VolumeRequest


def make_fake_runner(
    page_names: list[str],
    exit_code: int = 0,
    delay: float = 0.01,
    write_mokuro_on_success: bool = True,
) -> Callable:
    """A fake mokuro runner: writes one _ocr/*.json per page (with a small
    delay between each, like the real tqdm-driven loop would), then the
    final .mokuro file on success — without needing mokuro/torch installed."""

    async def fake_runner(volume_dir: Path, on_line) -> int:
        cache_dir = paths.ocr_cache_dir(volume_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        on_line("Processing pages...")
        for name in page_names:
            await asyncio.sleep(delay)
            (cache_dir / f"{name}.json").write_text("{}")

        if exit_code == 0 and write_mokuro_on_success:
            paths.mokuro_output_path(volume_dir).write_text("{}")
            on_line("Processed successfully: 1/1")
        else:
            on_line("Error while processing volume")

        return exit_code

    return fake_runner


def make_hanging_runner() -> Callable:
    """A fake runner that never completes on its own — used to test cancellation."""

    async def hanging_runner(volume_dir: Path, on_line) -> int:
        cache_dir = paths.ocr_cache_dir(volume_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        on_line("Processing pages...")
        await asyncio.sleep(3600)
        return 0  # pragma: no cover - never reached in tests

    return hanging_runner


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    (tmp_path / "Series").mkdir()
    return tmp_path


def make_volume(library_path: str, page_count: int = 2) -> VolumeRequest:
    return VolumeRequest(
        library_path=library_path,
        series_title="Series",
        volume_title=library_path.split("/")[-1],
        page_count=page_count,
    )
