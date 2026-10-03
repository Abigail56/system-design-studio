"""Clerk webhooks.

Keeps the local `User` table in step with Clerk. This is an optimisation, not
the only path: `deps.current_user` upserts on first authenticated request, so a
dropped webhook causes a short delay rather than a missing user.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select

from app.config import Settings, get_settings
from app.deps import SessionDep
from app.models import User

log = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])


async def _verify_signature(request: Request, body: bytes, settings: Settings) -> None:
    """Validate the Svix signature headers Clerk sends.

    Clerk signs webhooks through Svix, whose HMAC scheme is simple enough to
    verify inline: `t=<timestamp>,v1=<signature>` over `"{id}.{timestamp}.{body}"`.
    """
    webhook_id = request.headers.get("webhook-id")
    timestamp = request.headers.get("webhook-timestamp")
    signature = request.headers.get("webhook-signature")
    secret = settings.clerk_webhook_secret

    if not (webhook_id and timestamp and signature):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Missing webhook signature headers")
    if not secret:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "CLERK_WEBHOOK_SECRET is not configured")

    import base64
    import hashlib
    import hmac

    # Svix prefixes the secret with "whsec_" and stores it base64 after that.
    if not secret.startswith("whsec_"):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Malformed CLERK_WEBHOOK_SECRET")
    key = base64.b64decode(secret.removeprefix("whsec_"))

    expected = hmac.new(key, f"{webhook_id}.{timestamp}.".encode() + body, hashlib.sha256)
    expected_b64 = base64.b64encode(expected.digest()).decode()

    if not any(
        hmac.compare_digest(expected_b64, part.strip().removeprefix("v1,"))
        for part in signature.split(" ")
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid webhook signature")


def _primary_email(data: dict[str, Any]) -> str | None:
    addresses = data.get("email_addresses") or []
    if not addresses:
        return None
    primary_id = data.get("primary_email_address_id")
    primary = next((a for a in addresses if a.get("id") == primary_id), None)
    return (primary or addresses[0]).get("email_address", "").strip().lower() or None


def _full_name(data: dict[str, Any]) -> str | None:
    parts = [data.get("first_name"), data.get("last_name")]
    joined = " ".join(p for p in parts if p)
    return joined or None


@router.post("/clerk", status_code=status.HTTP_200_OK)
async def clerk_webhook(
    request: Request,
    session: SessionDep,
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    body = await request.body()
    await _verify_signature(request, body, settings)

    payload = await request.json()
    event_type: str = payload.get("type", "")
    data: dict[str, Any] = payload.get("data") or {}
    clerk_id: str | None = data.get("id")

    if not clerk_id:
        # Nothing useful to do; acknowledge so Clerk does not retry.
        return {"received": True}

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{settings.clerk_api_base}/users/{clerk_id}",
            headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
        )
        response.raise_for_status()
        user_data: dict[str, Any] = response.json()

    email = _primary_email(user_data) or _primary_email(data)
    name = _full_name(user_data) or _full_name(data)
    image_url = user_data.get("image_url") or data.get("image_url")

    if event_type in {"user.created", "user.updated"}:
        if not email:
            log.warning("clerk webhook %s: no email for %s", event_type, clerk_id)
            return {"received": True}

        await session.merge(
            User,
            {"clerk_id": clerk_id},
            {
                "clerk_id": clerk_id,
                "email": email,
                "name": name,
                "image_url": image_url,
            },
        )
        await session.commit()

    elif event_type == "user.deleted":
        existing = await session.scalar(
            select(User).where(User.clerk_id == clerk_id)
        )
        if existing is not None:
            await session.delete(existing)
            await session.commit()

    return {"received": True}