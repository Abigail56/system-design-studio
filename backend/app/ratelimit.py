"""Postgres-backed fixed-window rate limiting.

Why Postgres rather than Redis: this is the only high-write hot path in the
service, and adding Redis would be a new deployment, a new failure mode, and a
second source of truth for the AI spend we are trying to bound. At the volumes
this app will see (AI calls, project creates, invites) a single indexed
upsert is comfortably fast. If that stops being true, this module is the only
file that changes.

The counter increments and the decision are one atomic statement, so two
concurrent requests cannot both observe "under the limit" for the same slot.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# Expired windows are lazily reset on the next hit for that key, so there is no
# background sweeper. Rows for dead keys accumulate; see `purge_expired`.
_INCREMENT = text(
    """
    INSERT INTO rate_limit_bucket (key, window_start, count)
    VALUES (:key, :window, 1)
    ON CONFLICT (key) DO UPDATE SET
        count = CASE
            WHEN rate_limit_bucket.window_start < :window THEN 1
            ELSE rate_limit_bucket.count + 1
        END,
        window_start = CASE
            WHEN rate_limit_bucket.window_start < :window THEN :window
            ELSE rate_limit_bucket.window_start
        END
    RETURNING count
    """
)


@dataclass(frozen=True)
class LimitResult:
    allowed: bool
    limit: int
    remaining: int
    #: Seconds until the current window rolls over.
    reset_after: int


def _window_start(now: datetime, window_seconds: int) -> datetime:
    """Align windows to the clock so counters for one key expire together.

    Truncating to the window boundary means every caller's windows roll over at
    the same moment, which is what makes the reset hint in a `Retry-After`
    header meaningful.
    """
    epoch = int(now.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % window_seconds), tz=timezone.utc)


async def consume(
    session: AsyncSession,
    *,
    key: str,
    limit: int,
    window_seconds: int,
    now: datetime | None = None,
) -> LimitResult:
    """Count one hit against `key` and report whether it is within `limit`."""
    moment = now or datetime.now(timezone.utc)
    window = _window_start(moment, window_seconds)

    count = (await session.execute(_INCREMENT, {"key": key, "window": window})).scalar_one()
    await session.commit()

    reset_after = max(1, int((window + timedelta(seconds=window_seconds) - moment).total_seconds()))
    return LimitResult(
        allowed=count <= limit,
        limit=limit,
        remaining=max(0, limit - count),
        reset_after=reset_after,
    )


async def peek(
    session: AsyncSession,
    *,
    key: str,
    window_seconds: int,
    now: datetime | None = None,
) -> int:
    """Current count for `key` without incrementing. Used by tests."""
    moment = now or datetime.now(timezone.utc)
    window = _window_start(moment, window_seconds)

    row = await session.execute(
        text("SELECT count, window_start FROM rate_limit_bucket WHERE key = :key"),
        {"key": key},
    )
    record = row.first()

    if record is None:
        return 0
    count, started = record
    if started < window:
        return 0
    return int(count)


async def purge_expired(session: AsyncSession, *, older_than_seconds: int) -> int:
    """Delete rows whose window has long since rolled over."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=older_than_seconds)
    result = await session.execute(
        text("DELETE FROM rate_limit_bucket WHERE window_start < :cutoff"),
        {"cutoff": cutoff},
    )
    await session.commit()
    return result.rowcount or 0


async def reset(session: AsyncSession, *, key: str) -> None:
    """Clear one key. Test helper."""
    await session.execute(text("DELETE FROM rate_limit_bucket WHERE key = :key"), {"key": key})
    await session.commit()


# --- Named limits -----------------------------------------------------------
#
# Tuned against the cost model in the spec: an AI call is roughly $0.01-0.05
# and 30s of model time, so the hourly figures cap a runaway script at a few
# dollars per user per hour rather than stopping it entirely.


@dataclass(frozen=True)
class LimitRule:
    #: Calls permitted per window.
    limit: int
    window_seconds: int


LIMITS: dict[str, LimitRule] = {
    "ai:generate": LimitRule(limit=20, window_seconds=3600),
    "ai:chat": LimitRule(limit=60, window_seconds=3600),
    "ai:spec": LimitRule(limit=20, window_seconds=3600),
    "project:create": LimitRule(limit=30, window_seconds=3600),
    "project:invite": LimitRule(limit=50, window_seconds=3600),
    "snapshot:create": LimitRule(limit=120, window_seconds=3600),
}


def key_for(scope: str, subject: str) -> str:
    return f"{scope}:{subject}"


def rule(scope: str) -> LimitRule:
    try:
        return LIMITS[scope]
    except KeyError:
        raise KeyError(f"No rate limit configured for scope {scope!r}") from None