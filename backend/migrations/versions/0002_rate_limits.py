"""add rate limit buckets

Revision ID: 0002_rate_limits
Revises: 0001_initial
Create Date: 2026-09-30
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_rate_limits"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rate_limit_bucket",
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        sa.PrimaryKeyConstraint("key"),
    )
    # Supports the lazy sweep in ratelimit.purge_expired.
    op.create_index(
        "ix_rate_limit_bucket_window_start", "rate_limit_bucket", ["window_start"]
    )


def downgrade() -> None:
    op.drop_index("ix_rate_limit_bucket_window_start", table_name="rate_limit_bucket")
    op.drop_table("rate_limit_bucket")