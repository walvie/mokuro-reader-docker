"""Environment-driven configuration."""

import os
from pathlib import Path

LIBRARY_ROOT = Path(os.environ.get("LIBRARY_PATH", "/library")).resolve()
LIBRARY_SERVER_URL = os.environ.get("LIBRARY_SERVER_URL", "http://library-server:3300")
PORT = int(os.environ.get("PORT", "8100"))

# Capped so a very long-running volume doesn't grow an unbounded log in memory.
LOG_TAIL_MAX_LINES = int(os.environ.get("LOG_TAIL_MAX_LINES", "400"))

# How often (seconds) to re-count files in the _ocr cache dir while a job runs.
PROGRESS_POLL_INTERVAL_SECONDS = float(os.environ.get("PROGRESS_POLL_INTERVAL_SECONDS", "1.0"))
