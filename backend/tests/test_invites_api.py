"""Integration tests for the invite lifecycle.

The case that matters most is `pending invite redeems on first sign-in`: an
invite is stored for an unknown address, and later that address signs up. The
membership has to appear without anyone re-sending the invite.
"""

from __future__ import annotations

import pytest

from tests.conftest import as_user

pytestmark = pytest.mark.asyncio


async def create_project(client, name="Shared design", user="owner_a"):
    response = await client.post(
        "/v1/projects", json={"name": name}, headers=as_user(user)
    )
    assert response.status_code == 201, response.text
    return response.json()["project"]


async def test_known_email_becomes_a_member_immediately(client):
    """The invitee already has an account, so no pending row is needed."""
    await create_project(client, user="owner_a")
    project = (await client.get("/v1/projects", headers=as_user("owner_a"))).json()["projects"][0]

    # Bob signs in first, creating his user row.
    await client.get("/v1/projects", headers=as_user("bob"))

    response = await client.post(
        f"/v1/projects/{project['id']}/invites",
        json={"email": "bob@example.com", "role": "EDITOR"},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 201, response.text
    # Accepted: a live membership, not a pending invite.
    assert "member" in response.json()
    assert response.json()["member"]["role"] == "EDITOR"

    # Bob can now see it and his role comes through on the project.
    listed = await client.get("/v1/projects", headers=as_user("bob"))
    assert [p["name"] for p in listed.json()["projects"]] == ["Shared design"]
    assert listed.json()["projects"][0]["role"] == "EDITOR"


async def test_pending_invite_redeems_on_first_sign_in(client, session):
    """The core lifecycle: invite an unknown address, they sign up, they're in."""
    from sqlalchemy import select

    from app.models import ProjectInvite, ProjectMember, User

    project = await create_project(client, user="owner_a")
    pid = project["id"]

    response = await client.post(
        f"/v1/projects/{pid}/invites",
        json={"email": "newcomer@example.com", "role": "EDITOR"},
        headers=as_user("owner_a"),
    )
    # 202, not 201: the address has no account yet.
    assert response.status_code == 202, response.text
    # Pending: no account yet.
    assert "invite" in response.json()
    assert response.json()["invite"]["email"] == "newcomer@example.com"

    # Nothing has joined yet. The owner already has a membership row, so this
    # has to be specific to the invited address rather than counting rows.
    assert (
        await session.scalar(
            select(ProjectMember)
            .join(User, User.id == ProjectMember.user_id)
            .where(ProjectMember.project_id == pid, User.email == "newcomer@example.com")
        )
        is None
    )
    assert (
        len(
            (
                await session.scalars(
                    select(ProjectInvite).where(ProjectInvite.project_id == pid)
                )
            ).all()
        )
        == 1
    )

    # The invited person signs in for the first time.
    listed = await client.get("/v1/projects", headers=as_user("newcomer"))
    assert listed.status_code == 200
    assert [p["name"] for p in listed.json()["projects"]] == ["Shared design"]
    assert listed.json()["projects"][0]["role"] == "EDITOR"

    # The invite was consumed, not left to fire twice.
    assert await session.scalar(
        select(ProjectInvite).where(ProjectInvite.project_id == pid)
    ) is None


async def test_reinviting_updates_the_role_rather_than_duplicating(client):
    project = await create_project(client, user="owner_a")
    pid = project["id"]
    body = {"email": "someone@example.com", "role": "VIEWER"}

    first = await client.post(f"/v1/projects/{pid}/invites", json=body, headers=as_user("owner_a"))
    second = await client.post(
        f"/v1/projects/{pid}/invites",
        json={**body, "role": "EDITOR"},
        headers=as_user("owner_a"),
    )
    assert first.status_code == 202
    assert second.status_code == 202
    assert first.json()["invite"]["id"] == second.json()["invite"]["id"]
    assert second.json()["invite"]["role"] == "EDITOR"


async def test_owner_role_cannot_be_granted_by_invite(client):
    project = await create_project(client, user="owner_a")

    response = await client.post(
        f"/v1/projects/{project['id']}/invites",
        json={"email": "sneaky@example.com", "role": "OWNER"},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 422


async def test_invite_requires_owner(client, session):
    """An EDITOR cannot invite. Setup: owner invites bob, bob tries to invite."""
    from sqlalchemy import select

    from app.models import ProjectMember, User

    project = await create_project(client, user="owner_a")
    pid = project["id"]

    await client.get("/v1/projects", headers=as_user("bob"))
    bob = await session.scalar(select(User).where(User.clerk_id == "bob"))
    session.add(ProjectMember(project_id=pid, user_id=bob.id, role="EDITOR"))
    await session.commit()

    response = await client.post(
        f"/v1/projects/{pid}/invites",
        json={"email": "carol@example.com", "role": "VIEWER"},
        headers=as_user("bob"),
    )
    assert response.status_code == 403


async def test_invite_is_case_insensitive(client):
    project = await create_project(client, user="owner_a")
    response = await client.post(
        f"/v1/projects/{project['id']}/invites",
        json={"email": "  MiXeD@Example.Com  ", "role": "VIEWER"},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 202
    assert response.json()["invite"]["email"] == "mixed@example.com"


async def test_owner_cannot_be_removed(client, session):
    from sqlalchemy import select

    from app.models import User

    project = await create_project(client, user="owner_a")
    owner = await session.scalar(select(User).where(User.clerk_id == "owner_a"))

    response = await client.delete(
        f"/v1/projects/{project['id']}/members/{owner.id}", headers=as_user("owner_a")
    )
    assert response.status_code == 400


async def test_owner_can_remove_an_editor(client, session):
    from sqlalchemy import select

    from app.models import ProjectMember, User

    project = await create_project(client, user="owner_a")
    pid = project["id"]

    await client.get("/v1/projects", headers=as_user("bob"))
    bob = await session.scalar(select(User).where(User.clerk_id == "bob"))
    session.add(ProjectMember(project_id=pid, user_id=bob.id, role="EDITOR"))
    await session.commit()

    response = await client.delete(
        f"/v1/projects/{pid}/members/{bob.id}", headers=as_user("owner_a")
    )
    assert response.status_code == 200
    assert response.json()["removed"] is True

    # And access is gone.
    assert (await client.get(f"/v1/projects/{pid}", headers=as_user("bob"))).status_code == 404


async def test_revoke_invite(client, session):
    from sqlalchemy import select

    from app.models import ProjectInvite

    project = await create_project(client, user="owner_a")
    pid = project["id"]

    created = await client.post(
        f"/v1/projects/{pid}/invites",
        json={"email": "ghost@example.com", "role": "VIEWER"},
        headers=as_user("owner_a"),
    )
    invite_id = created.json()["invite"]["id"]

    response = await client.delete(
        f"/v1/projects/{pid}/invites/{invite_id}", headers=as_user("owner_a")
    )
    assert response.status_code == 204
    assert await session.scalar(
        select(ProjectInvite).where(ProjectInvite.id == invite_id)
    ) is None

    # The later sign-in must NOT create a membership from a revoked invite.
    listed = await client.get("/v1/projects", headers=as_user("ghost"))
    assert listed.json()["projects"] == []