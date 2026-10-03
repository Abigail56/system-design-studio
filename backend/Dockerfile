# syntax=docker/dockerfile:1

FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /srv

# Dependencies first so the layer caches across code changes.
COPY pyproject.toml uv.lock* ./
RUN pip install --no-cache-dir uv \
 && uv sync --frozen --no-dev --no-install-project || uv sync --no-dev --no-install-project

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

ENV PATH="/srv/.venv/bin:$PATH"
EXPOSE 8000

# Run migrations on boot so a new deploy never serves requests against an
# old schema. Rollback is handled by `alembic downgrade` out of band.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]