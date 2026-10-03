"""FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.auth import AuthError
from app.config import get_settings
from app.db import dispose_engine
from app.routers import ai, members, projects, snapshots, users, webhooks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


app = FastAPI(
    title="Ghost AI API",
    version="0.1.0",
    description="Projects, collaboration permissions, AI task orchestration.",
    lifespan=lifespan,
    docs_url="/docs" if not settings.is_production else None,
    openapi_url="/openapi.json" if not settings.is_production else None,
)

# The Next.js app calls this API from the browser (client components) and from
# the server (server components). Credentials are not used: auth is a bearer
# token in the Authorization header, so cookies are not needed here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)


@app.exception_handler(AuthError)
async def auth_error_handler(_request: Request, exc: AuthError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"error": exc.message})


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Normalise every error body to ``{"error": string}``.

    FastAPI's default is ``{"detail": ...}`` while `AuthError` used
    ``{"error": ...}``. Two shapes for one contract means every client has to
    check both, so funnel them all through one key here.

    Validation errors keep their structured list, since a client needs the
    per-field messages rather than a single string.
    """
    headers = getattr(exc, "headers", None)
    if isinstance(exc.detail, list):
        return JSONResponse(
            status_code=exc.status_code, content={"detail": exc.detail}, headers=headers
        )
    return JSONResponse(
        status_code=exc.status_code, content={"error": str(exc.detail)}, headers=headers
    )


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    """Liveness probe. Does not touch the database so a DB blip stays distinct."""
    return {"status": "ok"}


@app.get("/ready", tags=["ops"])
async def ready() -> dict[str, str]:
    """Readiness probe: verifies we can reach Postgres."""
    from sqlalchemy import text

    from app.db import _session_factory

    async with _session_factory() as session:
        await session.execute(text("SELECT 1"))
    return {"status": "ready"}


app.include_router(users.router, prefix="/v1")
app.include_router(projects.router, prefix="/v1")
app.include_router(members.router, prefix="/v1")
app.include_router(ai.router, prefix="/v1")
app.include_router(snapshots.router, prefix="/v1")
app.include_router(webhooks.router, prefix="/v1")