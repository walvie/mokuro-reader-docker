"""
Filesystem path arithmetic matching mokuro's own conventions (mokuro/volume.py):

  path_in        = <library_root>/<library_path>              (the image folder)
  path_mokuro    = path_in.parent / (path_in.name + ".mokuro")
  path_ocr_cache = path_mokuro.parent / "_ocr" / path_mokuro.stem

i.e. for library_path "Series/Volume 01":
  .mokuro  -> <root>/Series/Volume 01.mokuro
  _ocr dir -> <root>/Series/_ocr/Volume 01/

Kept as pure functions (no I/O) so they're trivially unit-testable and easy
to keep in sync if mokuro's own layout ever changes.
"""

from pathlib import Path


class UnsafeLibraryPathError(ValueError):
    """Raised when a library_path would resolve outside the library root."""


def resolve_volume_dir(library_root: Path, library_path: str) -> Path:
    """Resolve a library-relative path to an absolute path, rejecting traversal outside library_root."""
    candidate = (library_root / library_path).resolve()
    try:
        candidate.relative_to(library_root.resolve())
    except ValueError:
        raise UnsafeLibraryPathError(
            f"library_path {library_path!r} resolves outside the library root"
        ) from None
    return candidate


def mokuro_output_path(volume_dir: Path) -> Path:
    return volume_dir.parent / f"{volume_dir.name}.mokuro"


def ocr_cache_dir(volume_dir: Path) -> Path:
    mokuro_path = mokuro_output_path(volume_dir)
    return mokuro_path.parent / "_ocr" / mokuro_path.stem


def count_cached_pages(volume_dir: Path) -> int:
    """Number of per-page JSON files mokuro has written so far for this volume."""
    cache_dir = ocr_cache_dir(volume_dir)
    if not cache_dir.is_dir():
        return 0
    return sum(1 for p in cache_dir.iterdir() if p.suffix == ".json")
