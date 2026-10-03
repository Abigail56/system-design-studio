"""Email notifications sent through Resend."""

from __future__ import annotations

import html

import httpx

from app.config import Settings

RESEND_EMAILS_URL = "https://api.resend.com/emails"


class EmailDeliveryError(Exception):
    """The configured email provider did not accept the message."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


async def send_project_invite(
    settings: Settings,
    *,
    to_email: str,
    project_name: str,
    inviter_name: str,
    role: str,
    project_url: str,
) -> None:
    if not settings.resend_api_key or not settings.resend_from_email:
        raise EmailDeliveryError("Resend email settings are incomplete")

    safe_project = html.escape(project_name)
    safe_inviter = html.escape(inviter_name)
    safe_role = html.escape(role.lower())
    safe_url = html.escape(project_url, quote=True)
    payload = {
        "from": settings.resend_from_email,
        "to": [to_email],
        "subject": f"{inviter_name} invited you to {project_name}",
        "html": (
            f"<p>{safe_inviter} invited you to collaborate on "
            f"<strong>{safe_project}</strong> as a {safe_role}.</p>"
            f'<p><a href="{safe_url}">Open the canvas</a></p>'
            "<p>Sign in or create an account using this email address to join.</p>"
        ),
        "text": (
            f"{inviter_name} invited you to collaborate on {project_name} "
            f"as a {role.lower()}.\n\nOpen the canvas: {project_url}\n\n"
            "Sign in or create an account using this email address to join."
        ),
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                RESEND_EMAILS_URL,
                json=payload,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            )
    except httpx.HTTPError as exc:
        raise EmailDeliveryError("Resend could not be reached") from exc

    if response.is_error:
        raise EmailDeliveryError(
            f"Resend rejected the email with HTTP {response.status_code}",
            status_code=response.status_code,
        )
