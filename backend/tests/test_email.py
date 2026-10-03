import json

import httpx
import pytest

from app.config import Settings
from app.email import EmailDeliveryError, send_project_invite


def settings(**overrides) -> Settings:
    values = {
        "database_url": "postgresql+asyncpg://test:test@localhost/test",
        "clerk_secret_key": "test",
        "resend_api_key": "re_test",
        "resend_from_email": "invites@example.com",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.mark.asyncio
async def test_project_invite_is_sent_through_resend(monkeypatch):
    captured = {}

    def handle(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers["Authorization"]
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "email_123"})

    transport = httpx.MockTransport(handle)
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.email.httpx.AsyncClient",
        lambda **kwargs: real_async_client(transport=transport, **kwargs),
    )

    await send_project_invite(
        settings(),
        to_email="person@example.com",
        project_name="<Architecture>",
        inviter_name="A & B",
        role="EDITOR",
        project_url="http://localhost:3000/projects/project-1",
    )

    assert captured["authorization"] == "Bearer re_test"
    assert captured["payload"]["to"] == ["person@example.com"]
    assert captured["payload"]["subject"] == "A & B invited you to <Architecture>"
    assert "&lt;Architecture&gt;" in captured["payload"]["html"]
    assert "A &amp; B" in captured["payload"]["html"]
    assert "EDITOR" not in captured["payload"]["text"]
    assert "editor" in captured["payload"]["text"]


@pytest.mark.asyncio
async def test_resend_rejection_is_reported(monkeypatch):
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(422, json={"message": "invalid sender"})
    )
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.email.httpx.AsyncClient",
        lambda **kwargs: real_async_client(transport=transport, **kwargs),
    )

    with pytest.raises(EmailDeliveryError, match="HTTP 422") as error:
        await send_project_invite(
            settings(),
            to_email="person@example.com",
            project_name="Architecture",
            inviter_name="A",
            role="VIEWER",
            project_url="http://localhost:3000/projects/project-1",
        )
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_resend_unauthorized_key_is_identified(monkeypatch):
    transport = httpx.MockTransport(
        lambda _request: httpx.Response(401, json={"message": "unauthorized"})
    )
    real_async_client = httpx.AsyncClient
    monkeypatch.setattr(
        "app.email.httpx.AsyncClient",
        lambda **kwargs: real_async_client(transport=transport, **kwargs),
    )

    with pytest.raises(EmailDeliveryError) as error:
        await send_project_invite(
            settings(),
            to_email="person@example.com",
            project_name="Architecture",
            inviter_name="A",
            role="VIEWER",
            project_url="http://localhost:3000/projects/project-1",
        )
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_resend_requires_api_key_and_verified_sender():
    with pytest.raises(EmailDeliveryError, match="settings are incomplete"):
        await send_project_invite(
            settings(resend_api_key=None, resend_from_email=None),
            to_email="person@example.com",
            project_name="Architecture",
            inviter_name="A",
            role="VIEWER",
            project_url="http://localhost:3000/projects/project-1",
        )
