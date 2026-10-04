"""`/v1/me` — the frontend's source of truth for who the caller is."""

from __future__ import annotations

import asyncio

import pytest

from tests.conftest import as_user

pytestmark = pytest.mark.asyncio


async def test_me_creates_the_user_on_first_call(client, session):
    from sqlalchemy import select

    from app.models import User

    response = await client.get("/v1/me", headers=as_user("alice"))
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["user"]["email"] == "alice@example.com"
    assert body["user"]["name"] == "alice"

    stored = await session.scalar(select(User).where(User.clerk_id == "alice"))
    assert stored is not None
    assert stored.id == body["user"]["id"]


async def test_me_is_stable_across_calls(client):
    first = await client.get("/v1/me", headers=as_user("alice"))
    second = await client.get("/v1/me", headers=as_user("alice"))
    assert first.json() == second.json()


async def test_concurrent_first_requests_create_one_user(concurrent_client):
    first, second = await asyncio.gather(
        concurrent_client.get("/v1/me", headers=as_user("alice")),
        concurrent_client.get("/v1/me", headers=as_user("alice")),
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["user"]["id"] == second.json()["user"]["id"]


async def test_me_distinguishes_callers(client):
    alice = (await client.get("/v1/me", headers=as_user("alice"))).json()["user"]
    bob = (await client.get("/v1/me", headers=as_user("bob"))).json()["user"]
    assert alice["id"] != bob["id"]


async def test_me_requires_authentication(client):
    assert (await client.get("/v1/me")).status_code == 401
    assert (
        await client.get("/v1/me", headers={"Authorization": "Bearer garbage"})
    ).status_code == 401