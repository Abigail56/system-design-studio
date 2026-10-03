"""SQLAlchemy models mirroring the data model in the spec.

Enum columns use native Postgres enums via ``Enum(Role, name="role")``. They read
back as plain strings, so Pydantic schemas type them as ``str``.
"""

from __future__ import annotations

import enum
import secrets
import time
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def new_id() -> str:
    """Sortable, collision-resistant id generated app-side."""
    return format(int(time.time() * 1000), "x") + secrets.token_hex(8)


class Base(DeclarativeBase):
    pass


class Role(str, enum.Enum):
    OWNER = "OWNER"
    EDITOR = "EDITOR"
    VIEWER = "VIEWER"

    @property
    def rank(self) -> int:
        return {"VIEWER": 1, "EDITOR": 2, "OWNER": 3}[self.value]

    def allows(self, required: "Role") -> bool:
        return self.rank >= required.rank


class AITaskType(str, enum.Enum):
    GENERATE_DESIGN = "GENERATE_DESIGN"
    GENERATE_SPEC = "GENERATE_SPEC"


class AITaskStatus(str, enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class User(Base):
    __tablename__ = "user"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    clerk_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    email: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str | None] = mapped_column(String)
    image_url: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    projects: Mapped[list[Project]] = relationship(back_populates="owner")
    memberships: Mapped[list[ProjectMember]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Project(Base):
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    owner: Mapped[User] = relationship(back_populates="projects")
    members: Mapped[list[ProjectMember]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    invites: Mapped[list[ProjectInvite]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class ProjectMember(Base):
    __tablename__ = "project_member"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_member"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"), index=True)
    role: Mapped[Role] = mapped_column(
        Enum(Role, name="role"), nullable=False, server_default=Role.VIEWER.value
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="members")
    user: Mapped[User] = relationship(back_populates="memberships")


class ProjectInvite(Base):
    """A collaborator invited by email who has not signed up yet.

    Redeemed the first time that email authenticates.
    """

    __tablename__ = "project_invite"
    __table_args__ = (UniqueConstraint("project_id", "email", name="uq_project_invite"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id", ondelete="CASCADE"))
    email: Mapped[str] = mapped_column(String, index=True)
    role: Mapped[Role] = mapped_column(
        Enum(Role, name="role"), nullable=False, server_default=Role.VIEWER.value
    )
    invited_by_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    project: Mapped[Project] = relationship(back_populates="invites")


class ChatMessage(Base):
    __tablename__ = "chat_message"
    __table_args__ = (Index("ix_chat_message_project_created", "project_id", "created_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id", ondelete="CASCADE"))
    user_id: Mapped[str | None] = mapped_column(ForeignKey("user.id", ondelete="SET NULL"))
    role: Mapped[str] = mapped_column(String)  # "user" | "assistant"
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User | None] = relationship()


class Snapshot(Base):
    __tablename__ = "snapshot"
    __table_args__ = (Index("ix_snapshot_project_created", "project_id", "created_at"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id", ondelete="CASCADE"))
    blob_url: Mapped[str | None] = mapped_column(Text)
    # Fallback payload for environments with no Vercel Blob token. Keeps a
    # canvas document comfortably inside a Postgres TOAST row.
    state: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    created_by: Mapped[User] = relationship()


class RateLimitBucket(Base):
    """Fixed-window counter, one row per (key, window).

    Redis would be the usual choice here. Postgres keeps the dependency count at
    zero and is fast enough for this volume; if rate becomes a bottleneck the
    swap is confined to `app/ratelimit.py`.

    Keyed by a caller-supplied string such as ``"ai:generate:<user id>"``.
    """

    __tablename__ = "rate_limit_bucket"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    window_start: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AITask(Base):
    __tablename__ = "ai_task"
    __table_args__ = (
        Index("ix_ai_task_project_created", "project_id", "created_at"),
        Index("ix_ai_task_status", "status"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id", ondelete="CASCADE"))
    created_by_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"))
    type: Mapped[AITaskType] = mapped_column(Enum(AITaskType, name="ai_task_type"))
    status: Mapped[AITaskStatus] = mapped_column(
        Enum(AITaskStatus, name="ai_task_status"),
        nullable=False,
        server_default=AITaskStatus.QUEUED.value,
    )
    prompt: Mapped[str] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSONB)
    triggerdev_id: Mapped[str | None] = mapped_column(String)
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_by: Mapped[User] = relationship()


__all__ = [
    "Base",
    "new_id",
    "Role",
    "AITaskType",
    "AITaskStatus",
    "User",
    "Project",
    "ProjectMember",
    "ProjectInvite",
    "ChatMessage",
    "Snapshot",
    "AITask",
    "RateLimitBucket",
]