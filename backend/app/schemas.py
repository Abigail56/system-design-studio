"""Pydantic request/response schemas. The single source of truth for the API
contract the Next.js frontend codes against."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models import AITaskStatus, AITaskType

RoleLiteral = Literal["OWNER", "EDITOR", "VIEWER"]

# Pydantic's `min_length` counts whitespace, so "   " would satisfy
# `min_length=1`. Validators below strip first, then the length applies.
NonEmptyName = Annotated[str, Field(min_length=1, max_length=120)]


class Trimmed(BaseModel):
    """Base for schemas whose text fields should be stored trimmed.

    `check_fields=False` because the field names are declared on subclasses, not here.
    """

    @field_validator(
        "name", "description", "content", "prompt", mode="before", check_fields=False
    )
    @classmethod
    def _trim(cls, value):
        return value.strip() if isinstance(value, str) else value


# --- Users / members --------------------------------------------------------


class UserBrief(BaseModel):
    id: str
    name: str | None = None
    email: str
    image_url: str | None = None

    model_config = {"from_attributes": True}


class MeOut(BaseModel):
    """The caller's own identity, resolved from the session token."""

    user: UserBrief


class ProjectMemberOut(BaseModel):
    id: str
    role: RoleLiteral
    created_at: datetime
    user: UserBrief

    model_config = {"from_attributes": True}


class MemberListOut(BaseModel):
    members: list[ProjectMemberOut]


class MemberRemoveResult(BaseModel):
    removed: bool


# --- Projects ---------------------------------------------------------------


class ProjectBase(Trimmed):
    name: NonEmptyName
    description: str | None = Field(default=None, max_length=1000)


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(Trimmed):
    name: NonEmptyName | None = None
    description: str | None = Field(default=None, max_length=1000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    owner_id: str
    created_at: datetime
    updated_at: datetime
    role: RoleLiteral
    member_count: int
    snapshot_count: int


class ProjectListOut(BaseModel):
    projects: list[ProjectOut]


class ProjectDetailOut(ProjectOut):
    owner: UserBrief
    members: list[ProjectMemberOut]


# Single-resource responses are wrapped, matching the list endpoints. FastAPI
# would otherwise serialise the bare model, which is inconsistent and leaves no
# room for metadata like pagination later.
class ProjectEnvelope(BaseModel):
    project: ProjectOut


class ProjectDetailEnvelope(BaseModel):
    project: ProjectDetailOut


class MemberEnvelope(BaseModel):
    member: ProjectMemberOut


# --- Invites ----------------------------------------------------------------


class InviteCreate(BaseModel):
    email: EmailStr
    role: Literal["EDITOR", "VIEWER"] = "VIEWER"


class InviteOut(BaseModel):
    id: str
    email: str
    role: RoleLiteral
    created_at: datetime

    model_config = {"from_attributes": True}


class InviteListOut(BaseModel):
    invites: list[InviteOut]


class InviteNotificationOut(BaseModel):
    notification_sent: bool
    notification_message: str


class InviteAcceptedOut(InviteNotificationOut):
    """The invitee already had an account, so a membership exists now."""

    member: ProjectMemberOut


class InvitePendingOut(InviteNotificationOut):
    """The email has no account yet. The invite redeems on first sign-in."""

    invite: InviteOut


# --- Chat -------------------------------------------------------------------


class ChatMessageOut(BaseModel):
    id: str
    role: str
    content: str
    created_at: datetime
    user: UserBrief | None = None

    model_config = {"from_attributes": True}


class ChatHistoryOut(BaseModel):
    messages: list[ChatMessageOut]


# --- Snapshots --------------------------------------------------------------


class SnapshotCreate(BaseModel):
    project_id: str
    state: str = Field(max_length=4_000_000, description="Serialized Yjs canvas state")


class SnapshotOut(BaseModel):
    id: str
    project_id: str
    # NULL for inline snapshots, which carry their payload in Postgres.
    blob_url: str | None = None
    #: "blob" or "inline", so the UI can be honest about where it is stored.
    storage: str
    created_at: datetime
    created_by: UserBrief

    model_config = {"from_attributes": True}


class SnapshotRestoreOut(BaseModel):
    """One snapshot's canvas document, fetched for a restore."""

    state: str
    storage: str
    created_at: datetime


class SnapshotEnvelope(BaseModel):
    snapshot: SnapshotOut


class SnapshotListOut(BaseModel):
    snapshots: list[SnapshotOut]


# --- AI tasks ---------------------------------------------------------------


class GenerateRequest(Trimmed):
    project_id: str
    prompt: str = Field(min_length=1, max_length=30000)
    diagram_type: Literal["architecture", "erd"] = "architecture"


class SpecRequest(BaseModel):
    project_id: str


class AITaskOut(BaseModel):
    id: str
    project_id: str
    type: AITaskType
    status: AITaskStatus
    prompt: str
    result: dict | None = None
    error: str | None = None
    triggerdev_id: str | None = None
    created_at: datetime
    completed_at: datetime | None = None

    model_config = {"from_attributes": True}


class AITaskEnvelope(BaseModel):
    task: AITaskOut


class AITaskAcceptedOut(BaseModel):
    task_id: str
    status: AITaskStatus