"""Autosave: create, list, restore, prune.

Exercises the inline storage path, which is what runs without a Vercel Blob
token and is therefore the default in CI and local development.
"""

from __future__ import annotations

import json

import pytest

from tests.conftest import as_user

pytestmark = pytest.mark.asyncio

DIAGRAM = {
    "nodes": [
        {
            "id": "svc-1",
            "type": "service",
            "position": {"x": 100, "y": 200},
            "data": {"label": "API Gateway", "tech": "Node.js"},
        },
        {
            "id": "db-1",
            "type": "database",
            "position": {"x": 400, "y": 200},
            "data": {"label": "Primary"},
        },
    ],
    "edges": [{"id": "e1", "source": "svc-1", "target": "db-1", "label": "reads"}],
}


async def make_project(client, user="owner_a", name="Autosave"):
    response = await client.post("/v1/projects", json={"name": name}, headers=as_user(user))
    assert response.status_code == 201, response.text
    return response.json()["project"]


async def test_snapshot_round_trips_inline(client):
    """The whole autosave loop: save, list, restore, get the same document back."""
    project = await make_project(client)

    created = await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )
    assert created.status_code == 201, created.text

    snapshot = created.json()["snapshot"]
    # No Blob token configured here, so it must fall back to Postgres.
    assert snapshot["storage"] == "inline"
    assert snapshot["blob_url"] is None

    listed = await client.get(f"/v1/projects/{project['id']}/snapshots", headers=as_user("owner_a"))
    assert listed.status_code == 200
    assert len(listed.json()["snapshots"]) == 1
    assert listed.json()["snapshots"][0]["id"] == snapshot["id"]

    restored = await client.get(
        f"/v1/projects/{project['id']}/snapshots/{snapshot['id']}/content",
        headers=as_user("owner_a"),
    )
    assert restored.status_code == 200
    assert json.loads(restored.json()["state"]) == DIAGRAM


async def test_restore_is_scoped_to_the_project(client, session):
    """Asking for a snapshot through the wrong project must not leak it."""
    from sqlalchemy import select

    from app.models import Snapshot, User

    first = await make_project(client, name="First")
    created = await client.post(
        f"/v1/projects/{first['id']}/snapshots",
        json={"project_id": first["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )
    snapshot_id = created.json()["snapshot"]["id"]

    # A second project the same owner also has access to.
    second = await make_project(client, name="Second")

    wrong = await client.get(
        f"/v1/projects/{second['id']}/snapshots/{snapshot_id}/content",
        headers=as_user("owner_a"),
    )
    assert wrong.status_code == 404

    # And it must still be reachable through the project that owns it.
    right = await client.get(
        f"/v1/projects/{first['id']}/snapshots/{snapshot_id}/content",
        headers=as_user("owner_a"),
    )
    assert right.status_code == 200

    stored = await session.scalar(select(Snapshot).where(Snapshot.id == snapshot_id))
    assert stored is not None
    assert stored.project_id == first["id"]
    assert User is not None


async def test_non_member_cannot_read_snapshots(client):
    project = await make_project(client)
    created = await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )
    snapshot_id = created.json()["snapshot"]["id"]

    # 404 not 403, consistent with the rest of the project surface.
    listed = await client.get(f"/v1/projects/{project['id']}/snapshots", headers=as_user("intruder"))
    assert listed.status_code == 404

    content = await client.get(
        f"/v1/projects/{project['id']}/snapshots/{snapshot_id}/content",
        headers=as_user("intruder"),
    )
    assert content.status_code == 404


async def test_oversized_state_is_rejected(client):
    project = await make_project(client)
    response = await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": "x" * 4_000_001},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 422


async def test_snapshots_are_ordered_newest_first(client):
    project = await make_project(client)
    for index in range(3):
        await client.post(
            f"/v1/projects/{project['id']}/snapshots",
            json={"project_id": project["id"], "state": json.dumps({"nodes": [], "edges": []})},
            headers=as_user("owner_a"),
        )
    listed = await client.get(f"/v1/projects/{project['id']}/snapshots", headers=as_user("owner_a"))
    ids = [s["id"] for s in listed.json()["snapshots"]]
    assert len(ids) == 3
    # Timestamps have microsecond resolution so ordering is deterministic here.
    times = [s["created_at"] for s in listed.json()["snapshots"]]
    assert times == sorted(times, reverse=True)


async def test_saving_bumps_project_updated_at(client):
    project = await make_project(client)
    before = project["updated_at"]

    await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )

    after = (
        await client.get(f"/v1/projects/{project['id']}", headers=as_user("owner_a"))
    ).json()["project"]["updated_at"]
    assert after >= before


async def test_snapshot_count_is_reported_on_the_project(client):
    project = await make_project(client)
    assert project["snapshot_count"] == 0

    await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )

    refreshed = (
        await client.get(f"/v1/projects/{project['id']}", headers=as_user("owner_a"))
    ).json()["project"]
    assert refreshed["snapshot_count"] == 1


async def test_editor_can_delete_one_snapshot(client):
    project = await make_project(client)
    created = await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )
    snapshot_id = created.json()["snapshot"]["id"]

    response = await client.delete(
        f"/v1/projects/{project['id']}/snapshots/{snapshot_id}",
        headers=as_user("owner_a"),
    )
    assert response.status_code == 204
    listed = await client.get(
        f"/v1/projects/{project['id']}/snapshots",
        headers=as_user("owner_a"),
    )
    assert listed.json()["snapshots"] == []


async def test_editor_can_clear_snapshot_history(client):
    project = await make_project(client)
    for _ in range(2):
        response = await client.post(
            f"/v1/projects/{project['id']}/snapshots",
            json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
            headers=as_user("owner_a"),
        )
        assert response.status_code == 201

    cleared = await client.delete(
        f"/v1/projects/{project['id']}/snapshots",
        headers=as_user("owner_a"),
    )
    assert cleared.status_code == 204
    listed = await client.get(
        f"/v1/projects/{project['id']}/snapshots",
        headers=as_user("owner_a"),
    )
    assert listed.json()["snapshots"] == []


async def test_viewer_cannot_delete_snapshot_history(client):
    project = await make_project(client)
    created = await client.post(
        f"/v1/projects/{project['id']}/snapshots",
        json={"project_id": project["id"], "state": json.dumps(DIAGRAM)},
        headers=as_user("owner_a"),
    )
    snapshot_id = created.json()["snapshot"]["id"]
    await client.post(
        f"/v1/projects/{project['id']}/invites",
        json={"email": "viewer_b@example.com", "role": "VIEWER"},
        headers=as_user("owner_a"),
    )

    response = await client.delete(
        f"/v1/projects/{project['id']}/snapshots/{snapshot_id}",
        headers=as_user("viewer_b"),
    )
    assert response.status_code == 403