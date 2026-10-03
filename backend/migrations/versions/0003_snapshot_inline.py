"""store snapshot state inline when blob is unavailable

Revision ID: 0003_snapshot_inline
Revises: 0002_rate_limits
Create Date: 2026-10-01

Without a Vercel Blob token the snapshot endpoint had nowhere to put the
canvas document, so autosave could not run at all in local development. This
adds a nullable `state` column so a snapshot can carry its payload in
Postgres. Rows written this way have `blob_url = NULL`.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_snapshot_inline"
down_revision: str | None = "0002_rate_limits"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("snapshot", sa.Column("state", sa.Text(), nullable=True))
    # blob_url was NOT NULL, which is what made the inline path impossible.
    op.alter_column("snapshot", "blob_url", existing_type=sa.Text(), nullable=True)


def downgrade() -> None:
    op.alter_column("snapshot", "blob_url", existing_type=sa.Text(), nullable=False)
    op.drop_column("snapshot", "state")