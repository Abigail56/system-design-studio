"""Integration tests for project CRUD and role gating against a real database."""

from __future__ import annotations

import pytest

from tests.conftest import as_user

pytestmark = pytest.mark.asyncio


async def create_project(client, name="Payments platform", user="owner_a"):
    response = await client.post(
        "/v1/projects",
        json={"name": name, "description": "Card processing"},
        headers=as_user(user),
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]


async def test_first_request_creates_the_user_row(client, session):
    """The Clerk user is upserted on first authenticated request."""
    from sqlalchemy import select

    from app.models import User

    project = await create_project(client, user="owner_a")

    user = await session.scalar(select(User).where(User.clerk_id == "owner_a"))
    assert user is not None
    assert user.email == "owner_a@example.com"
    assert project["owner_id"] == user.id


async def test_creator_becomes_owner_with_a_membership_row(client):
    project = await create_project(client, user="owner_a")

    assert project["role"] == "OWNER"
    # member_count includes the owner, so the membership row really exists.
    assert project["member_count"] == 1

    detail = await client.get(f"/v1/projects/{project['id']}", headers=as_user("owner_a"))
    assert detail.status_code == 200
    assert len(detail.json()["project"]["members"]) == 1


async def test_blank_name_is_rejected(client):
    response = await client.post(
        "/v1/projects", json={"name": "   "}, headers=as_user("owner_a")
    )
    assert response.status_code == 422


async def test_listing_is_scoped_to_the_caller(client):
    mine = await create_project(client, name="Mine", user="owner_a")
    await create_project(client, name="Theirs", user="owner_b")

    response = await client.get("/v1/projects", headers=as_user("owner_a"))
    assert response.status_code == 200

    names = [p["name"] for p in response.json()["projects"]]
    assert names == ["Mine"]
    assert mine["name"] in names


async def test_non_member_gets_404_not_403(client):
    """404 rather than 403 so project ids cannot be enumerated."""
    project = await create_project(client, user="owner_a")

    response = await client.get(f"/v1/projects/{project['id']}", headers=as_user("intruder"))
    assert response.status_code == 404


async def test_missing_bearer_token_is_401(client):
    response = await client.get("/v1/projects")
    assert response.status_code == 401


async def test_invalid_token_is_401(client):
    response = await client.get("/v1/projects", headers={"Authorization": "Bearer garbage"})
    assert response.status_code == 401


async def test_owner_can_rename(client):
    project = await create_project(client, user="owner_a")

    response = await client.patch(
        f"/v1/projects/{project['id']}", json={"name": "Renamed"}, headers=as_user("owner_a")
    )
    assert response.status_code == 200
    assert response.json()["project"]["name"] == "Renamed"


async def test_non_owner_cannot_rename(client):
    """No membership yet, so this is a 404 rather than a 403."""
    project = await create_project(client, user="owner_a")

    response = await client.patch(
        f"/v1/projects/{project['id']}", json={"name": "Hijacked"}, headers=as_user("intruder")
    )
    assert response.status_code == 404


async def test_delete_cascades_to_children(client, session):
    from sqlalchemy import func, select

    from app.models import AITask, Project, ProjectInvite, ProjectMember, Snapshot

    project = await create_project(client, user="owner_a")
    pid = project["id"]

    session.add(Snapshot(project_id=pid, blob_url="https://blob/x", created_by_id=project["owner_id"]))
    await session.commit()
    assert await session.scalar(select(func.count()).select_from(Snapshot)) == 1

    response = await client.delete(f"/v1/projects/{pid}", headers=as_user("owner_a"))
    assert response.status_code == 204

    for model in (Project, ProjectMember, Snapshot, ProjectInvite, AITask):
        remaining = await session.scalar(
            select(func.count()).select_from(model).where(model.__table__.c.get("project_id") == pid)
        ) if "project_id" in model.__table__.c else await session.scalar(
            select(func.count()).select_from(model)
        )
        assert remaining == 0, f"{model.__tablename__} not cleaned up"