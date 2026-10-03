"""Integration tests for rate limiting.

The counter is real Postgres here, which is the point: the increment is a
single `INSERT ... ON CONFLICT DO UPDATE`, and the interesting failure mode is
two concurrent requests both deciding they are under the limit.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from app.ai import AIResult
from tests.conftest import as_user

pytestmark = pytest.mark.asyncio


async def make_project(client, user="owner_a", name="Rate limited"):
    response = await client.post("/v1/projects", json={"name": name}, headers=as_user(user))
    assert response.status_code == 201, response.text
    return response.json()["project"]


async def test_limits_are_configured_for_every_cost_bearing_endpoint():
    from app.ratelimit import LIMITS

    for scope in ("ai:generate", "ai:spec", "project:create", "project:invite"):
        rule = LIMITS[scope]
        assert rule.limit > 0
        assert rule.window_seconds > 0


async def test_create_allows_up_to_the_limit_then_429s(client):
    from app.ratelimit import rule

    limit = rule("project:create")

    for index in range(limit.limit):
        response = await client.post(
            "/v1/projects", json={"name": f"P{index}"}, headers=as_user("owner_a")
        )
        assert response.status_code == 201, response.text

    blocked = await client.post(
        "/v1/projects", json={"name": "one too many"}, headers=as_user("owner_a")
    )
    assert blocked.status_code == 429

    # Enough detail for a client to back off without guessing.
    assert blocked.headers.get("Retry-After")
    assert blocked.headers["X-RateLimit-Limit"] == str(limit.limit)
    assert blocked.headers["X-RateLimit-Remaining"] == "0"


async def test_budget_is_per_user_not_global(client):
    from app.ratelimit import rule

    limit = rule("project:create")
    for index in range(limit.limit):
        response = await client.post(
            "/v1/projects", json={"name": f"A{index}"}, headers=as_user("user_one")
        )
        assert response.status_code == 201

    assert (
        await client.post(
            "/v1/projects", json={"name": "blocked"}, headers=as_user("user_one")
        )
    ).status_code == 429

    # A different user is unaffected. IP-based limiting would get this wrong
    # for two people sharing one NAT address.
    assert (
        await client.post(
            "/v1/projects", json={"name": "fine"}, headers=as_user("user_two")
        )
    ).status_code == 201


async def test_rate_limited_request_creates_nothing(client):
    from app.ratelimit import rule

    limit = rule("project:create")
    for index in range(limit.limit):
        await client.post(
            "/v1/projects", json={"name": f"R{index}"}, headers=as_user("owner_a")
        )

    listed = await client.get("/v1/projects", headers=as_user("owner_a"))
    before = len(listed.json()["projects"])

    blocked = await client.post(
        "/v1/projects", json={"name": "should not exist"}, headers=as_user("owner_a")
    )
    listed_after = await client.get("/v1/projects", headers=as_user("owner_a"))
    after = len(listed_after.json()["projects"])

    assert blocked.status_code == 429
    assert before == after == limit.limit


async def test_ai_generate_is_rate_limited(client, session, stub_model):
    from app.ratelimit import rule

    project = await make_project(client)
    limit = rule("ai:generate")

    # The endpoint also caps in-flight tasks per project (a separate guard), so
    # retire each task as we go. Otherwise that cap trips first and this test
    # would pass without ever exercising the rate limiter.
    async def retire():
        await session.execute(
            text("UPDATE ai_task SET status = 'COMPLETED' WHERE status = 'QUEUED'")
        )
        await session.commit()

    for index in range(limit.limit):
        response = await client.post(
            "/v1/ai/generate",
            json={"project_id": project["id"], "prompt": f"Design {index}"},
            headers=as_user("owner_a"),
        )
        assert response.status_code == 200, response.text
        await retire()

    blocked = await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "one too many"},
        headers=as_user("owner_a"),
    )
    assert blocked.status_code == 429
    assert blocked.headers["X-RateLimit-Limit"] == str(limit.limit)


async def test_ai_in_flight_cap_is_separate_from_the_rate_limit(
    client, session, engine
):
    """At most 3 tasks of one type may be RUNNING for a project at a time.

    Tested by calling the guard directly rather than through HTTP. Going through
    `/generate` means racing real concurrent requests against a model call, which
    makes the test depend on task interleaving and go flaky; the guard itself is
    a two-statement critical section and is what deserves pinning down.

    Each caller gets its own session and transaction, which is the situation the
    advisory lock exists for.
    """
    import asyncio

    from fastapi import HTTPException
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models import AITask, AITaskStatus, AITaskType, Project
    from app.routers.ai import MAX_INFLIGHT_PER_TYPE, _claim_slot

    project_id = (await make_project(client))["id"]
    LAUNCHED = 8

    factory = async_sessionmaker(engine, expire_on_commit=False)

    # The guard takes the ORM model; make_project returns the API response.
    async with factory() as lookup:
        project = await lookup.get(Project, project_id)
        assert project is not None
        owner_id = project.owner_id

    async def attempt(index: int) -> bool:
        """Returns True if this caller claimed a slot."""
        async with factory() as own:
            # Each attempt commits its claim before the next can count it, which
            # is what a real request does after passing the guard.
            task = AITask(
                project_id=project_id,
                created_by_id=owner_id,
                type=AITaskType.GENERATE_DESIGN,
                status=AITaskStatus.RUNNING,
                prompt=f"p{index}",
            )
            try:
                await _claim_slot(own, project, AITaskType.GENERATE_DESIGN)
            except HTTPException as exc:
                # 429 means the cap refused this caller, which is the point.
                assert exc.status_code == 429
                return False
            own.add(task)
            await own.commit()
            return True

    results = await asyncio.gather(*(attempt(i) for i in range(LAUNCHED)))
    claimed = sum(results)

    assert claimed == MAX_INFLIGHT_PER_TYPE, (
        f"advisory lock did not serialise the check-then-act: "
        f"{claimed} of {LAUNCHED} claimed a slot, cap is {MAX_INFLIGHT_PER_TYPE}"
    )


@pytest.fixture
def stub_model(monkeypatch):
    """Stub the model call.

    `/v1/ai/generate` performs a real completion, so without a provider key it
    returns 503 and this test would never reach the rate limiter it is about.
    The response must be a valid diagram: the validator rejects an empty node
    list, which is correct behaviour pinned in test_ai.py.
    """
    async def fake(*_args, **_kwargs):
        return AIResult(
            text='{"nodes": [{"id": "a", "type": "service", "data": {"label": "A"}}], "edges": []}',
            model="test",
        )

    monkeypatch.setattr("app.ai_design.complete_text", fake)
