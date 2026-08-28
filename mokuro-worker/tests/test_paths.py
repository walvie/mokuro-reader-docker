from pathlib import Path

import pytest

from app import paths


def test_mokuro_output_path_matches_mokuro_conventions(tmp_path):
    volume_dir = tmp_path / "Series" / "Volume 01"
    assert paths.mokuro_output_path(volume_dir) == tmp_path / "Series" / "Volume 01.mokuro"


def test_ocr_cache_dir_matches_mokuro_conventions(tmp_path):
    volume_dir = tmp_path / "Series" / "Volume 01"
    assert paths.ocr_cache_dir(volume_dir) == tmp_path / "Series" / "_ocr" / "Volume 01"


def test_paths_for_a_volume_directly_at_the_library_root(tmp_path):
    volume_dir = tmp_path / "Volume 01"
    assert paths.mokuro_output_path(volume_dir) == tmp_path / "Volume 01.mokuro"
    assert paths.ocr_cache_dir(volume_dir) == tmp_path / "_ocr" / "Volume 01"


def test_resolve_volume_dir_joins_under_the_library_root(tmp_path):
    (tmp_path / "Series" / "Volume 01").mkdir(parents=True)
    resolved = paths.resolve_volume_dir(tmp_path, "Series/Volume 01")
    assert resolved == (tmp_path / "Series" / "Volume 01").resolve()


def test_resolve_volume_dir_rejects_traversal_outside_the_library_root(tmp_path):
    with pytest.raises(paths.UnsafeLibraryPathError):
        paths.resolve_volume_dir(tmp_path, "../../etc/passwd")


def test_count_cached_pages_counts_only_json_files(tmp_path):
    volume_dir = tmp_path / "Series" / "Volume 01"
    cache_dir = paths.ocr_cache_dir(volume_dir)
    cache_dir.mkdir(parents=True)
    (cache_dir / "0001.json").write_text("{}")
    (cache_dir / "0002.json").write_text("{}")
    (cache_dir / "not-a-page.txt").write_text("junk")

    assert paths.count_cached_pages(volume_dir) == 2


def test_count_cached_pages_is_zero_before_processing_starts(tmp_path):
    volume_dir = tmp_path / "Series" / "Volume 01"
    assert paths.count_cached_pages(volume_dir) == 0
