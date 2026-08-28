import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .config import LIBRARY_ROOT
from .models import Job, JobCreateRequest
from .queue import JobQueue
from .rescan import trigger_library_rescan

logging.basicConfig(level=logging.INFO)

job_queue = JobQueue(library_root=LIBRARY_ROOT, rescan_callback=trigger_library_rescan)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    job_queue.start()
    try:
        yield
    finally:
        await job_queue.stop()


app = FastAPI(title="mokuro-worker", lifespan=lifespan)


@app.get("/api/mokuro/health")
def health():
    return {"ok": True, "library_root": str(LIBRARY_ROOT)}


@app.get("/api/mokuro/jobs")
def list_jobs() -> list[Job]:
    # Most recently created first — the queue/history view cares about what's
    # active or just finished, not what was queued first historically.
    return list(reversed(job_queue.list_jobs()))


@app.post("/api/mokuro/jobs")
def create_jobs(request: JobCreateRequest) -> list[Job]:
    return [job_queue.enqueue(volume) for volume in request.volumes]


@app.get("/api/mokuro/jobs/{job_id}")
def get_job(job_id: str) -> Job:
    job = job_queue.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.delete("/api/mokuro/jobs/{job_id}")
def cancel_job(job_id: str) -> Job:
    job = job_queue.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request, exc: Exception):
    logging.getLogger("mokuro_worker").exception("Unhandled error")
    return JSONResponse(status_code=500, content={"detail": str(exc)})
