"""Unit tests for logic that needs no database.

Run with `uv run pytest` from the `api/` directory.
"""

from __future__ import annotations

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from app.auth import AuthError, verify_session_token
from app.config import Settings
from app.models import AITaskStatus, Role
from app.schemas import InviteCreate, ProjectCreate, SnapshotCreate


# --- Role ranking -----------------------------------------------------------


def test_role_ordering_is_linear():
    assert Role.OWNER.allows(Role.OWNER)
    assert Role.OWNER.allows(Role.EDITOR)
    assert Role.OWNER.allows(Role.VIEWER)
    assert not Role.VIEWER.allows(Role.EDITOR)
    assert not Role.VIEWER.allows(Role.OWNER)


def test_editor_cannot_manage_members():
    assert Role.EDITOR.allows(Role.EDITOR)
    assert not Role.EDITOR.allows(Role.OWNER)


# --- Schema validation ------------------------------------------------------


def test_project_name_cannot_be_blank():
    with pytest.raises(ValueError):
        ProjectCreate(name="   ")


def test_project_name_length_capped():
    with pytest.raises(ValueError):
        ProjectCreate(name="x" * 121)


def test_snapshot_state_is_size_capped():
    with pytest.raises(ValueError):
        SnapshotCreate(project_id="p1", state="x" * 4_000_001)


def test_invite_rejects_owner_role():
    # OWNER is transferable, never grantable, so the literal excludes it.
    with pytest.raises(ValueError):
        InviteCreate(email="a@example.com", role="OWNER")


def test_invite_defaults_to_viewer():
    assert InviteCreate(email="a@example.com").role == "VIEWER"


def test_ai_task_status_values():
    assert {s.value for s in AITaskStatus} == {
        "QUEUED",
        "RUNNING",
        "COMPLETED",
        "FAILED",
    }


# --- Clerk session verification --------------------------------------------


@pytest.fixture(scope="module")
def rsa_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _settings() -> Settings:
    return Settings(
        database_url="postgresql+asyncpg://u:p@localhost:5432/x",
        clerk_secret_key="sk_test",
        clerk_jwks_url="http://unused.invalid/jwks",
    )


def _token(private_key, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": "user_abc",
        "azp": "https://example.clerk.accounts.dev",
        "iat": now,
        "nbf": now - 5,
        "exp": now + 600,
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm="RS256")


async def test_verify_returns_subject(rsa_key, monkeypatch):
    settings = _settings()
    monkeypatch.setattr(
        "app.auth._get_jwks_client",
        lambda _s: type(
            "C",
            (),
            {"get_signing_key_from_jwt": staticmethod(lambda _t: type("K", (), {"key": rsa_key.public_key()})())},
        ),
    )
    assert await verify_session_token(_token(rsa_key), settings) == "user_abc"


async def test_expired_token_is_rejected(rsa_key, monkeypatch):
    settings = _settings()
    monkeypatch.setattr(
        "app.auth._get_jwks_client",
        lambda _s: type(
            "C",
            (),
            {"get_signing_key_from_jwt": staticmethod(lambda _t: type("K", (), {"key": rsa_key.public_key()})())},
        ),
    )
    expired = _token(rsa_key, exp=int(time.time()) - 60)
    with pytest.raises(AuthError) as exc:
        await verify_session_token(expired, settings)
    assert exc.value.status == 401


async def test_missing_token_is_rejected():
    with pytest.raises(AuthError):
        await verify_session_token("", _settings())


async def test_token_without_subject_is_rejected(rsa_key, monkeypatch):
    settings = _settings()
    monkeypatch.setattr(
        "app.auth._get_jwks_client",
        lambda _s: type(
            "C",
            (),
            {"get_signing_key_from_jwt": staticmethod(lambda _t: type("K", (), {"key": rsa_key.public_key()})())},
        ),
    )
    with pytest.raises(AuthError):
        await verify_session_token(_token(rsa_key, sub=""), settings)