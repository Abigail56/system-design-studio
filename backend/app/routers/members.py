"""Invites and member removal.

An invite for an email that already has an account becomes a `ProjectMember`
immediately. Otherwise a `ProjectInvite` row is written and redeemed the first
time that email authenticates (see `deps.current_user`).
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import delete, select

from app.config import Settings
from app.deps import CurrentUser, ProjectOwner, SessionDep, SettingsDep, enforce
from app.email import EmailDeliveryError, send_project_invite
from app.models import ProjectInvite, ProjectMember, Role, User
from app.schemas import (
    InviteCreate,
    InviteAcceptedOut,
    InviteListOut,
    InviteOut,
    InvitePendingOut,
    MemberRemoveResult,
    ProjectMemberOut,
    UserBrief,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["members"])
logger = logging.getLogger(__name__)


async def _send_invite_notification(
    settings: Settings,
    *,
    email: str,
    project_id: str,
    project_name: str,
    inviter_name: str,
    role: Role,
) -> tuple[bool, str]:
    if not settings.resend_api_key or not settings.resend_from_email:
        return (
            False,
            "Invite saved, but email notifications are not configured. Set "
            "RESEND_API_KEY and RESEND_FROM_EMAIL in backend/.env.",
        )

    try:
        await send_project_invite(
            settings,
            to_email=email,
            project_name=project_name,
            inviter_name=inviter_name,
            role=role.value,
            project_url=(
                f"{settings.frontend_url.rstrip('/')}/projects/"
                f"{quote(project_id, safe='')}"
            ),
        )
    except EmailDeliveryError as exc:
        logger.exception("Invite email delivery failed for project %s", project_id)
        if exc.status_code == 401:
            return (
                False,
                "Invite saved, but Resend rejected the API key (HTTP 401). Replace "
                "RESEND_API_KEY in backend/.env and restart the API.",
            )
        if exc.status_code == 403:
            return (
                False,
                "Invite saved, but Resend rejected the sender (HTTP 403). Verify "
                "the sending domain and sender address in Resend.",
            )
        if exc.status_code is not None:
            return (
                False,
                f"Invite saved, but Resend rejected the email (HTTP {exc.status_code}).",
            )
        return False, "Invite saved, but the email could not be delivered. Try again later."
    return True, f"Resend accepted the invitation email for delivery to {email}."


# Two outcomes, distinguished by status code and by which key is present:
#   201 {"member": {...}}  the invitee had an account, membership is live
#   202 {"invite": {...}}  no account yet, redeem on first sign-in
@router.post(
    "/invites",
    response_model=InviteAcceptedOut | InvitePendingOut,
    status_code=status.HTTP_202_ACCEPTED,
    responses={201: {"model": InviteAcceptedOut, "description": "Member added"}},
)
async def create_invite(
    payload: InviteCreate,
    project: ProjectOwner,
    session: SessionDep,
    user: CurrentUser,
    settings: SettingsDep,
    response: Response,
) -> InviteAcceptedOut | InvitePendingOut:
    """Invite by email.

    Known email -> a membership is created now and a `ProjectMember` comes back.
    Unknown email -> a `ProjectInvite` is stored and an `InviteOut` comes back;
    it redeems automatically on that address's first sign-in.

    Rate limited per inviting user so one owner cannot mass-invite addresses.
    """
    await enforce("project:invite", session, user)

    email = payload.email.lower()
    role = Role(payload.role)

    invitee = await session.scalar(select(User).where(User.email == email))

    if invitee is not None:
        already_member = await session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project.id,
                ProjectMember.user_id == invitee.id,
            )
        )
        if already_member is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Already a member of this project"
            )

        member = ProjectMember(project_id=project.id, user_id=invitee.id, role=role)
        session.add(member)
        await session.commit()
        await session.refresh(member)
        notification_sent, notification_message = await _send_invite_notification(
            settings,
            email=email,
            project_id=project.id,
            project_name=project.name,
            inviter_name=user.name or user.email,
            role=role,
        )

        # A membership now exists, so this is a creation rather than an
        # acceptance of something pending. The decorator's 202 is the default
        # for the other branch.
        response.status_code = status.HTTP_201_CREATED
        return InviteAcceptedOut(
            notification_sent=notification_sent,
            notification_message=notification_message,
            member=ProjectMemberOut(
                id=member.id,
                role=member.role.value,
                created_at=member.created_at,
                user=UserBrief.model_validate(invitee),
            )
        )

    existing = await session.scalar(
        select(ProjectInvite).where(
            ProjectInvite.project_id == project.id,
            ProjectInvite.email == email,
        )
    )
    if existing is not None:
        # Re-inviting updates the role rather than duplicating the row.
        existing.role = role
        invite = existing
    else:
        invite = ProjectInvite(
            project_id=project.id,
            email=email,
            role=role,
            invited_by_id=project.owner_id,
        )
        session.add(invite)

    await session.commit()
    await session.refresh(invite)
    notification_sent, notification_message = await _send_invite_notification(
        settings,
        email=email,
        project_id=project.id,
        project_name=project.name,
        inviter_name=user.name or user.email,
        role=role,
    )
    return InvitePendingOut(
        notification_sent=notification_sent,
        notification_message=notification_message,
        invite=InviteOut.model_validate(invite),
    )


@router.get("/invites", response_model=InviteListOut)
async def list_invites(
    project: ProjectOwner,
    session: SessionDep,
) -> InviteListOut:
    rows = await session.execute(
        select(ProjectInvite)
        .where(ProjectInvite.project_id == project.id)
        .order_by(ProjectInvite.created_at.desc())
    )
    return InviteListOut(invites=[InviteOut.model_validate(row) for row in rows.scalars()])


@router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invite(
    invite_id: str,
    project: ProjectOwner,
    session: SessionDep,
) -> Response:
    result = await session.execute(
        delete(ProjectInvite).where(
            ProjectInvite.id == invite_id,
            ProjectInvite.project_id == project.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invite not found")

    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/members/{user_id}", response_model=MemberRemoveResult)
async def remove_member(
    user_id: str,
    project: ProjectOwner,
    session: SessionDep,
) -> MemberRemoveResult:
    """Remove a collaborator. The owner is protected so a project always has one."""
    if project.owner_id == user_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The project owner cannot be removed")

    result = await session.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == project.id,
            ProjectMember.user_id == user_id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Member not found")

    await session.commit()
    return MemberRemoveResult(removed=True)