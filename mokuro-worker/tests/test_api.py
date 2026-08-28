import time

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.queue import JobQueue

from .conftest import make_fake_runner, make_hanging_runner


def volume_payload(library_path: str, page_count: int = 2) -> dict:
    return {
        "library_path": library_path,
        "series_title": "Series",
        "volume_title": library_path.split("/")[-1],
        "page_count": page_count,
    }


@pytest.fixture
def client(library_root, monkeypatch):
    # main.py's routes close over the module-level `job_queue` global — point
    # it at a fresh, isolated queue (own tmp_path library root, fake runner)
    # before the TestClient triggers app startup, rather than hitting the
    # real filesystem or sharing state across tests.
    test_queue = JobQueue(
        library_root=library_root,
        runner=make_fake_runner(["0001", "0002"]),
        poll_interval=0.01,
    )
    monkeypatch.setattr(main_module, "job_queue", test_queue)

    with TestClient(main_module.app) as c:
        c.queue = test_queue
        yield c


def test_health(client):
    res = client.get("/api/mokuro/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_create_and_list_jobs(client):
    res = client.post("/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]})
    assert res.status_code == 200
    created = res.json()
    assert len(created) == 1
    # Could already be "running" by the time this response is read back — the
    # fake runner is fast and the worker loop may have picked it up already.
    assert created[0]["status"] in ("queued", "running")
    assert created[0]["library_path"] == "Series/Volume 01"

    listed = client.get("/api/mokuro/jobs").json()
    assert len(listed) == 1
    assert listed[0]["id"] == created[0]["id"]


def test_create_multiple_volumes_in_one_request(client):
    res = client.post(
        "/api/mokuro/jobs",
        json={"volumes": [volume_payload("Series/Volume 01"), volume_payload("Series/Volume 02")]},
    )
    assert res.status_code == 200
    assert len(res.json()) == 2


def test_create_jobs_requires_at_least_one_volume(client):
    res = client.post("/api/mokuro/jobs", json={"volumes": []})
    assert res.status_code == 422


def test_get_single_job(client):
    created = client.post(
        "/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]}
    ).json()[0]

    res = client.get(f"/api/mokuro/jobs/{created['id']}")
    assert res.status_code == 200
    assert res.json()["id"] == created["id"]


def test_get_unknown_job_404s(client):
    res = client.get("/api/mokuro/jobs/does-not-exist")
    assert res.status_code == 404


def test_a_job_reaches_done_via_the_api(client):
    created = client.post(
        "/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]}
    ).json()[0]

    for _ in range(200):
        status = client.get(f"/api/mokuro/jobs/{created['id']}").json()["status"]
        if status == "done":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("job never reached done")

    final = client.get(f"/api/mokuro/jobs/{created['id']}").json()
    assert final["pages_done"] == 2


def test_cancel_unknown_job_404s(client):
    res = client.delete("/api/mokuro/jobs/does-not-exist")
    assert res.status_code == 404


def test_cancel_a_queued_job(client):
    # Occupy the worker with a hanging job so the second one stays queued.
    client.queue._runner = make_hanging_runner()
    client.post("/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Blocker")]})

    target = client.post(
        "/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]}
    ).json()[0]

    res = client.delete(f"/api/mokuro/jobs/{target['id']}")
    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"


def test_a_dedup_reused_job_is_not_recreated(client):
    client.queue._runner = make_hanging_runner()
    first = client.post(
        "/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]}
    ).json()[0]
    second = client.post(
        "/api/mokuro/jobs", json={"volumes": [volume_payload("Series/Volume 01")]}
    ).json()[0]

    assert first["id"] == second["id"]
    assert len(client.get("/api/mokuro/jobs").json()) == 1
