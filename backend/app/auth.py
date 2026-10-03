"""Clerk session-token verification.

Clerk signs session JWTs with RS256. We verify against Clerk's JWKS, then read
the profile from the Clerk Backend API. Session tokens deliberately carry no
email, so each first-seen user triggers one Clerk lookup which is then cached
for a short TTL to keep request latency flat.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx
import jwt
from jwt import PyJWKClient

from app.config import Settings

_jwks_clients: dict[str, PyJWKClient] = {}

# (clerk_user_id) -> (profile, expires_at_monotonic)
_profile_cache: dict[str, tuple["ClerkProfile", float]] = {}
_PROFILE_TTL_SECONDS = 300


@dataclass(frozen=True)
class ClerkProfile:
    clerk_id: str
    email: str
    name: str | None
    image_url: str | None


class AuthError(Exception):
    """Raised when a request has no usable Clerk session."""

    def __init__(self, message: str, status: int = 401) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _jwks_url(settings: Settings) -> str:
    if settings.clerk_jwks_url:
        return settings.clerk_jwks_url
    # Accounts on the default Clerk domain expose JWKS here.
    return "https://clerk.com/.well-known/jwks.json"


def _get_jwks_client(settings: Settings) -> PyJWKClient:
    url = _jwks_url(settings)
    client = _jwks_clients.get(url)
    if client is None:
        client = PyJWKClient(url, cache_keys=True)
        _jwks_clients[url] = client
    return client


async def verify_session_token(token: str, settings: Settings) -> str:
    """Verify a Clerk session JWT and return the Clerk user id.

    Raises ``AuthError`` when the token is missing, malformed, expired or signed
    by an unknown key.
    """
    if not token:
        raise AuthError("Missing bearer token")

    try:
        jwks_client = _get_jwks_client(settings)
        # PyJWKClient does blocking network I/O for a cache miss.
        import anyio.to_thread

        signing_key = await anyio.to_thread.run_sync(lambda: jwks_client.get_signing_key_from_jwt(token))

        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_aud": False, "verify_exp": True},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("Session expired") from exc
    except jwt.PyJWTError as exc:
        raise AuthError("Invalid session token") from exc
    except Exception as exc:  # network failure while fetching JWKS
        raise AuthError("Could not verify session token") from exc

    clerk_id = payload.get("sub")
    if not clerk_id:
        raise AuthError("Session token missing subject")

    # `azp` is the authorized party (the frontend API origin). Not enforced in v1
    # because the set of valid origins is per-Clerk-instance configuration.
    return str(clerk_id)


async def fetch_profile(clerk_id: str, settings: Settings) -> ClerkProfile:
    """Look up (or reuse a cached) Clerk profile for a user id."""
    cached = _profile_cache.get(clerk_id)
    now = time.monotonic()
    if cached and cached[1] > now:
        return cached[0]

    headers = {"Authorization": f"Bearer {settings.clerk_secret_key}"}
    url = f"{settings.clerk_api_base}/users/{clerk_id}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()

    emails = data.get("email_addresses") or []
    primary_id = data.get("primary_email_address_id")
    primary = next((e for e in emails if e.get("id") == primary_id), None)
    address = (primary or (emails[0] if emails else {}))
    email = (address.get("email_address") or "").strip().lower()
    if not email:
        raise AuthError("Clerk user has no email address", status=422)

    full_name = data.get("first_name"), data.get("last_name")
    profile = ClerkProfile(
        clerk_id=clerk_id,
        email=email,
        name=" ".join(part for part in full_name if part) or None,
        image_url=data.get("image_url"),
    )

    if len(_profile_cache) > 5000:
        _profile_cache.clear()
    _profile_cache[clerk_id] = (profile, now + _PROFILE_TTL_SECONDS)
    return profile