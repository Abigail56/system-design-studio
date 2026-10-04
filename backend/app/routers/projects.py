"""Project CRUD. Every route resolves the caller through `CurrentUser`, and
project-scoped routes go through `require_project` / `RoleGate` so membership
and role are enforced in one place.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import CurrentUser, ProjectOwner, SessionDep, enforce, require_project
from app.models import Project, ProjectMember, Role, Snapshot, User
from app.schemas import (
    ProjectCreate,
    ProjectDetailEnvelope,
    ProjectDetailOut,
    ProjectEnvelope,
    ProjectListOut,
    ProjectMemberOut,
    ProjectOut,
    ProjectUpdate,
    UserBrief,
)

router = APIRouter(prefix="/projects", tags=["projects"])


async def _project_out(
    session: AsyncSession,
    project: Project,
    role: Role,
) -> ProjectEnvelope:
    """ProjectOut plus its two denormalised counters.

    Counted separately: a single query joining both tables would multiply the
    rows and report the product as the count.
    """
    member_count = await session.scalar(
        select(func.count())
        .select_from(ProjectMember)
        .where(ProjectMember.project_id == project.id)
    )
    snapshot_count = await session.scalar(
        select(func.count())
        .select_from(Snapshot)
        .where(Snapshot.project_id == project.id)
    )

    return ProjectEnvelope(
        project=ProjectOut(
            id=project.id,
            name=project.name,
            description=project.description,
            owner_id=project.owner_id,
            created_at=project.created_at,
            updated_at=project.updated_at,
            role=role.value,
            member_count=member_count or 0,
            snapshot_count=snapshot_count or 0,
        ),
    )


async def _members_of(
    session: AsyncSession, project_id: str
) -> list[ProjectMemberOut]:
    rows = await session.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
        .order_by(ProjectMember.created_at.asc())
    )
    return [
        ProjectMemberOut(
            id=member.id,
            role=member.role.value,
            created_at=member.created_at,
            user=UserBrief.model_validate(member_user),
        )
        for member, member_user in rows.all()
    ]


@router.get("", response_model=ProjectListOut)
async def list_projects(session: SessionDep, user: CurrentUser) -> ProjectListOut:
    """Projects where the caller is a member, most recently touched first."""
    rows = await session.execute(
        select(Project, ProjectMember.role)
        .join(ProjectMember, ProjectMember.project_id == Project.id)
        .where(ProjectMember.user_id == user.id)
        .order_by(Project.updated_at.desc())
    )

    projects = [
        (await _project_out(session, project, role)).project
        for project, role in rows.all()
    ]
    return ProjectListOut(projects=projects)


@router.post("", response_model=ProjectDetailEnvelope, status_code=status.HTTP_201_CREATED)
async def create_project(
    payload: ProjectCreate,
    session: SessionDep,
    user: CurrentUser,
) -> ProjectDetailEnvelope:
    """Create a project. Rate limited per user: each one writes a new Liveblocks room."""
    await enforce("project:create", session, user)

    project = Project(name=payload.name, description=payload.description, owner_id=user.id)
    session.add(project)
    await session.flush()

    # The owner gets an explicit membership row so member listings are uniform.
    owner_member = ProjectMember(project_id=project.id, user_id=user.id, role=Role.OWNER)
    session.add(owner_member)
    await session.commit()
    await session.refresh(project)
    await session.refresh(owner_member)

    base = await _project_out(session, project, Role.OWNER)
    return ProjectDetailEnvelope(
        project=ProjectDetailOut(
            **base.project.model_dump(),
            owner=UserBrief.model_validate(user),
            members=[
                ProjectMemberOut(
                    id=owner_member.id,
                    role=owner_member.role.value,
                    created_at=owner_member.created_at,
                    user=UserBrief.model_validate(user),
                )
            ],
        )
    )


@router.get("/{project_id}", response_model=ProjectDetailEnvelope)
async def get_project(
    project_id: str,
    session: SessionDep,
    user: CurrentUser,
) -> ProjectDetailEnvelope:
    project, role = await require_project(project_id, session, user)
    owner = await session.get(User, project.owner_id)

    base = await _project_out(session, project, role)
    return ProjectDetailEnvelope(
        project=ProjectDetailOut(
            **base.project.model_dump(),
            owner=UserBrief.model_validate(owner),
            members=await _members_of(session, project_id),
        )
    )


@router.patch("/{project_id}", response_model=ProjectEnvelope)
async def update_project(
    payload: ProjectUpdate,
    project: ProjectOwner,
    session: SessionDep,
) -> ProjectEnvelope:
    updates = payload.model_dump(exclude_unset=True)
    if updates:
        for field, value in updates.items():
            setattr(project, field, value)
        await session.commit()
        await session.refresh(project)

    return await _project_out(session, project, Role.OWNER)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project: ProjectOwner,
    session: SessionDep,
) -> Response:
    # Members, invites, messages, snapshots and tasks all cascade in Postgres.
    await session.delete(project)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{project_id}/members", response_model=list[ProjectMemberOut])
async def list_members(
    project_id: str,
    session: SessionDep,
    user: CurrentUser,
) -> list[ProjectMemberOut]:
    await require_project(project_id, session, user)
    return await _members_of(session, project_id)