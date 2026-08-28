from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    error = "error"
    cancelled = "cancelled"


TERMINAL_STATUSES = {JobStatus.done, JobStatus.error, JobStatus.cancelled}


class VolumeRequest(BaseModel):
    """One volume the frontend wants processed, as returned by library-server's /api/volumes."""

    library_path: str
    series_title: str
    volume_title: str
    page_count: int = Field(ge=0)


class JobCreateRequest(BaseModel):
    volumes: list[VolumeRequest] = Field(min_length=1)


class Job(BaseModel):
    id: str
    library_path: str
    series_title: str
    volume_title: str
    page_count: int
    status: JobStatus
    pages_done: int = 0
    error: Optional[str] = None
    log_tail: list[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
