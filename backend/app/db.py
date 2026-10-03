from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

_settings = get_settings()

_engine = create_async_engine(
    _settings.database_url,
    pool_pre_ping=True,
    # asyncpg hands back dates in UTC already, so skip the server-side tz shift.
    connect_args={"server_settings": {"timezone": "UTC"}},
)

_session_factory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncSession:
    """FastAPI dependency yielding a request-scoped session."""
    async with _session_factory() as session:
        yield session


async def dispose_engine() -> None:
    await _engine.dispose()