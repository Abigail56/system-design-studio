"""The caller's own identity.

Lets the frontend ask the API who it is rather than asking Clerk. The API is
already the authority on identity, since it verified the session token, and
this keeps Clerk out of the Server Components entirely.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import CurrentUser
from app.schemas import MeOut, UserBrief

router = APIRouter(tags=["users"])


@router.get("/me", response_model=MeOut)
async def get_me(user: CurrentUser) -> MeOut:
    return MeOut(
        user=UserBrief(
            id=user.id,
            name=user.name,
            email=user.email,
            image_url=user.image_url,
        )
    )