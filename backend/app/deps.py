"""FastAPI dependencies: resolve the caller, then gate on project role."""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import ratelimit
from app.auth import AuthError, fetch_profile, verify_session_token
from app.config import Settings, get_settings
from app.db import get_session
from app.models import Project, ProjectMember, Role, User

SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


def bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AuthError("Missing bearer token")
    return token.strip()


async def current_user(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
) -> User:
    """Resolve the Clerk session to a local ``User`` row.

    Upserts on first sight, which doubles as the Clerk-webhook fallback, then
    redeems any pending project invites for this email.
    """
    if settings.dev_auth:
        return await _dev_user(session, settings)

    token = bearer_token(request)
    clerk_id = await verify_session_token(token, settings)
    profile = await fetch_profile(clerk_id, settings)

    user = await session.scalar(select(User).where(User.clerk_id == clerk_id))
    if user is None:
        user = User(
            clerk_id=profile.clerk_id,
            email=profile.email,
            name=profile.name,
            image_url=profile.image_url,
        )
        session.add(user)
        await session.flush()
    else:
        # Keep the local copy in step with Clerk.
        user.email = profile.email
        user.name = profile.name
        user.image_url = profile.image_url

    await _redeem_invites(session, user)
    await session.commit()
    return user


CurrentUser = Annotated[User, Depends(current_user)]


async def _dev_user(session: AsyncSession, settings: Settings) -> User:
    """Fixed identity for local development, without a Clerk account.

    Only reachable when `DEV_AUTH` is set, and `Settings` refuses to construct
    in that state when `ENVIRONMENT=production`. Every caller is therefore the
    same user, which is the point: one local identity to create projects and
    invites against.
    """
    user = await session.scalar(
        select(User).where(User.clerk_id == settings.dev_auth_clerk_id)
    )
    if user is None:
        user = User(
            clerk_id=settings.dev_auth_clerk_id,
            email=settings.dev_auth_email,
            name="Local Developer",
            image_url=None,
        )
        session.add(user)
        await session.flush()

    await _redeem_invites(session, user)
    await session.commit()
    return user


async def _redeem_invites(session: AsyncSession, user: User) -> None:
    from app.models import ProjectInvite

    result = await session.execute(
        select(ProjectInvite).where(ProjectInvite.email == user.email)
    )
    invites = list(result.scalars())
    if not invites:
        return

    for invite in invites:
        exists = await session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == invite.project_id,
                ProjectMember.user_id == user.id,
            )
        )
        if exists is None:
            session.add(
                ProjectMember(
                    project_id=invite.project_id,
                    user_id=user.id,
                    role=invite.role,
                )
            )
        await session.delete(invite)

    # A user must never end up a member of a project they do not own without an
    # owner row surviving; the owner membership is created with the project.


async def project_role(session: AsyncSession, project_id: str, user_id: str) -> Role | None:
    member = await session.scalar(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    )
    return member.role if member else None


async def require_project(
    project_id: str,
    session: SessionDep,
    user: CurrentUser,
) -> tuple[Project, Role]:
    """Load the project and assert membership at VIEWER or above.

    Non-members get 404 rather than 403 so project ids are not enumerable.
    """
    project = await session.get(Project, project_id)
    if project is None:
        raise AuthError("Project not found", status=404)

    # The owner always holds OWNER authority even if the membership row is absent.
    if project.owner_id == user.id:
        return project, Role.OWNER

    role = await project_role(session, project_id, user.id)
    if role is None:
        raise AuthError("Project not found", status=404)
    return project, role


def require_role(project_role_value: Role, required: Role) -> Role:
    if not project_role_value.allows(required):
        raise AuthError(f"Requires {required.value} access", status=403)
    return project_role_value


class RoleGate:
    """Dependency factory: inject a Project once the caller has at least `required`.

    Returns the Project alone, not `(project, role)`. FastAPI injects whatever
    this returns without looking at the return annotation, so returning a tuple
    here hands every route a tuple even though `ProjectOwner` promises a
    Project. Routes that need the role call `require_project` directly, or read
    `user_role` from the request-scoped cache below.
    """

    def __init__(self, required: Role) -> None:
        self.required = required

    async def __call__(
        self,
        project_id: str,
        session: SessionDep,
        user: CurrentUser,
    ) -> Project:
        project, role = await require_project(project_id, session, user)
        require_role(role, self.required)
        return project


# Route signatures use these instead of `Depends(RoleGate(...))` so every
# dependency is an Annotated alias and no parameter carries a Python default.
ProjectViewer = Annotated[Project, Depends(RoleGate(Role.VIEWER))]
ProjectEditor = Annotated[Project, Depends(RoleGate(Role.EDITOR))]
ProjectOwner = Annotated[Project, Depends(RoleGate(Role.OWNER))]


async def enforce(scope: str, session: AsyncSession, user: User) -> None:
    """Charge one request against `user`'s budget for `scope`, or raise 429.

    Deliberately keyed on the user id, not the IP address:

    - A shared office or NAT IP would otherwise let one person exhaust a quota
      that everyone behind that IP shares.
    - IP is trivially rotated by an attacker, so it under-counts deliberate
      abuse.
    - IP-based lockout on a cost-bearing endpoint is a denial-of-service
      lever: an attacker who knows a victim's IP can lock that specific person
      out without ever touching their account.

    IP limiting still has a place on unauthenticated endpoints, where there is
    no user id to key on. There are none in this service today.
    """
    limit = ratelimit.rule(scope)
    result = await ratelimit.consume(
        session,
        key=ratelimit.key_for(scope, user.id),
        limit=limit.limit,
        window_seconds=limit.window_seconds,
    )
    if not result.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Rate limit reached. Try again in {result.reset_after}s.",
            headers={
                "Retry-After": str(result.reset_after),
                "X-RateLimit-Limit": str(result.limit),
                "X-RateLimit-Remaining": str(result.remaining),
            },
        )