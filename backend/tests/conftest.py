"""Integration test fixtures.

These talk to a real Postgres. Start one with:

    docker compose up -d db

Point the tests at it with:

    export TEST_DATABASE_URL=postgresql+asyncpg://ghost:ghost@localhost:55432/ghost_test

Tests are skipped when `TEST_DATABASE_URL` is unset so plain `pytest` still
works with no infrastructure. That guard is deliberate: silently falling back
to `DATABASE_URL` is how integration tests end up truncating someone's data.

The schema is built by running the real Alembic migrations in a subprocess, not
by `metadata.create_all`, so the migrations themselves are covered.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio

# Set before anything imports `app.config`, which reads `.env` at import time.
# A developer's local `api/.env` has DEV_AUTH=true so the app can run without
# Clerk. Without these lines the suite silently inherits that bypass and every
# auth assertion passes against one fake identity.
os.environ["DEV_AUTH"] = "false"
os.environ["ENVIRONMENT"] = "test"

TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL not set; skipping database tests",
)

# Truncated between tests. Quoted because `user` is a Postgres reserved word and
# TRUNCATE will not accept it bare: "syntax error at or near user".
TRUNCATE_ALL = (
    'TRUNCATE rate_limit_bucket, ai_task, snapshot, chat_message, '
    'project_invite, project_member, project, "user" RESTART IDENTITY CASCADE'
)


@pytest.fixture(scope="session")
def migrated_database() -> Iterator[str]:
    """Reset the test schema, then build it with the real Alembic migrations.

    Building via `alembic upgrade head` rather than `metadata.create_all` means
    the migrations themselves are covered by the integration tests.
    """
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL not set")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # asyncpg does not understand SQLAlchemy's "+asyncpg" driver suffix.
    dsn = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")

    # Drop the schema outright instead of relying on `alembic downgrade base`:
    # a partially-reverted database makes `upgrade head` a no-op that then looks
    # like it passed.
    reset = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import asyncio, sys, asyncpg\n"
                "\n"
                "async def main():\n"
                "    c = await asyncpg.connect(sys.argv[1])\n"
                "    await c.execute('DROP SCHEMA public CASCADE')\n"
                "    await c.execute('CREATE SCHEMA public')\n"
                "    await c.close()\n"
                "\n"
                "asyncio.run(main())\n"
            ),
            dsn,
        ],
        cwd=root, capture_output=True, text=True,
    )
    if reset.returncode != 0:
        pytest.fail(f"could not reset test schema:\n{reset.stdout}\n{reset.stderr}")

    env = {
        **os.environ,
        "DATABASE_URL": TEST_DATABASE_URL,
        "CLERK_SECRET_KEY": "sk_test_tests",
    }
    upgrade = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=root, env=env, capture_output=True, text=True,
    )
    if upgrade.returncode != 0:
        pytest.fail(f"alembic upgrade head failed:\n{upgrade.stdout}\n{upgrade.stderr}")

    yield TEST_DATABASE_URL


@pytest_asyncio.fixture
async def engine(migrated_database: str) -> AsyncIterator:
    """A fresh engine per test, so its pool lives and dies with the event loop.

    The app's module-level engine pools connections across event loops, which
    produces 'Event loop is closed' teardown errors under function-scoped loops.
    """
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool

    eng = create_async_engine(migrated_database, poolclass=NullPool)
    try:
        yield eng
    finally:
        await eng.dispose()


@pytest_asyncio.fixture
async def session(engine) -> AsyncIterator:
    """A session against the test database, truncated before and after each test."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker

    factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as conn:
        await conn.execute(text(TRUNCATE_ALL))

    async with factory() as sess:
        yield sess

    async with engine.begin() as conn:
        await conn.execute(text(TRUNCATE_ALL))


@pytest_asyncio.fixture
async def client_factory(session, monkeypatch, engine):
    """Builds HTTP clients against the app.

    Two modes, because they test different things:

    - default: every request shares one `AsyncSession`, so a test can set up rows
      and assert on them directly. Fast, and correct for sequential tests.
    - `isolated=True`: each request gets its own session and transaction. Needed
      for anything concurrent, because SQLAlchemy refuses two operations on one
      session at the same time. That refusal is a harness limitation, not a
      product one, so tests that need real concurrency ask for this.
    """
    import app.auth as auth_module
    import app.deps as deps_module
    from httpx import ASGITransport, AsyncClient

    from app.db import get_session
    from app.main import app as fastapi_app

    async def fake_verify(token: str, _settings):
        if not token:
            raise auth_module.AuthError("Missing bearer token")
        if not token.startswith("clerk:"):
            raise auth_module.AuthError("Invalid session token")
        return token.removeprefix("clerk:")

    async def fake_profile(clerk_id: str, _settings):
        return auth_module.ClerkProfile(
            clerk_id=clerk_id,
            email=f"{clerk_id}@example.com",
            name=clerk_id,
            image_url=None,
        )

    # Patch where the names are used: deps.py did
    # `from app.auth import verify_session_token`, so patching app.auth alone
    # would not affect it.
    monkeypatch.setattr(deps_module, "verify_session_token", fake_verify)
    monkeypatch.setattr(deps_module, "fetch_profile", fake_profile)

    from sqlalchemy.ext.asyncio import async_sessionmaker

    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def make(isolated: bool = False):
        if isolated:

            async def per_request():
                async with factory() as own:
                    yield own

            fastapi_app.dependency_overrides[get_session] = per_request
        else:

            async def shared():
                yield session

            fastapi_app.dependency_overrides[get_session] = shared

        transport = ASGITransport(app=fastapi_app)
        return AsyncClient(transport=transport, base_url="http://test")

    try:
        yield make
    finally:
        fastapi_app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(session, monkeypatch, client_factory):
    """A sequential client sharing the test session."""
    async with await client_factory(isolated=False) as http:
        yield http


@pytest_asyncio.fixture
async def concurrent_client(client_factory):
    """A client giving each request its own session, for concurrent tests."""
    async with await client_factory(isolated=True) as http:
        yield http


def as_user(clerk_id: str) -> dict[str, str]:
    """Authorization header for a fake Clerk user. See `client` above."""
    return {"Authorization": f"Bearer clerk:{clerk_id}"}