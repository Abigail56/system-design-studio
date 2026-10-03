"""Canvas snapshots.

Two storage backends behind one endpoint:

- **Vercel Blob** when `BLOB_READ_WRITE_TOKEN` is set. The document lives in a
  blob and Postgres holds only the index.
- **Postgres inline** otherwise. The document is stored in `snapshot.state` so
  autosave still works locally instead of failing with "not configured".

`POST` returns where the payload went, and `GET` reports it per snapshot, so the
UI can be honest about which mode it is in rather than silently pretending.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, select

from app.config import Settings
from app.deps import (
    CurrentUser,
    ProjectEditor,
    SessionDep,
    SettingsDep,
    enforce,
    require_project,
)
from app.models import Role, Snapshot, User
from app.schemas import (
    SnapshotCreate,
    SnapshotEnvelope,
    SnapshotListOut,
    SnapshotOut,
    SnapshotRestoreOut,
    UserBrief,
)

router = APIRouter(prefix="/projects/{project_id}/snapshots", tags=["snapshots"])

# Keep only the most recent N index rows per project.
MAX_SNAPSHOTS_PER_PROJECT = 100
BLOB_UPLOAD_TIMEOUT_SECONDS = 30.0


def storage_mode(settings: Settings) -> str:
    return "blob" if settings.blob_read_write_token else "inline"


async def _upload_to_blob(settings: Settings, path: str, body: bytes) -> str:
    """PUT the payload to Vercel Blob and return its public URL.

    Talks to the REST API directly to keep the dependency list small.
    """
    url = f"https://blob.vercel-storage.com/{path}"
    headers = {
        "Authorization": f"Bearer {settings.blob_read_write_token}",
        "x-content-type": "application/json",
    }

    async with httpx.AsyncClient(timeout=BLOB_UPLOAD_TIMEOUT_SECONDS) as client:
        response = await client.put(url, content=body, headers=headers)

    if response.status_code >= 400:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            f"Snapshot upload failed ({response.status_code})",
        )

    payload = response.json()
    return payload.get("url") or payload.get("downloadUrl") or url


@router.post("", response_model=SnapshotEnvelope, status_code=status.HTTP_201_CREATED)
async def create_snapshot(
    payload: SnapshotCreate,
    project: ProjectEditor,
    session: SessionDep,
    settings: SettingsDep,
    user: CurrentUser,
) -> SnapshotEnvelope:
    """Store the current canvas state. Requires EDITOR or above."""
    await enforce("snapshot:create", session, user)

    raw = payload.state
    if settings.blob_read_write_token:
        blob_url = await _upload_to_blob(
            settings,
            f"snapshots/{project.id}/{int(time.time() * 1000)}.json",
            raw.encode("utf-8"),
        )
        inline_state = None
    else:
        blob_url = None
        inline_state = raw

    snapshot = Snapshot(
        project_id=project.id,
        blob_url=blob_url,
        state=inline_state,
        created_by_id=user.id,
    )
    session.add(snapshot)

    # Touch the project so the dashboard list sorts active canvases first.
    project.updated_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(snapshot)
    await _prune(session, project.id)

    return SnapshotEnvelope(
        snapshot=SnapshotOut(
            id=snapshot.id,
            project_id=snapshot.project_id,
            blob_url=snapshot.blob_url,
            storage=storage_mode(settings),
            created_at=snapshot.created_at,
            created_by=UserBrief.model_validate(user),
        )
    )


async def _prune(session: SessionDep, project_id: str) -> None:
    """Delete index rows past the retention limit.

    Only the Postgres rows go; blobs are cheap and leaving them avoids a second
    network round trip on the autosave path.
    """
    stale = list(
        await session.scalars(
            select(Snapshot.id)
            .where(Snapshot.project_id == project_id)
            .order_by(Snapshot.created_at.desc())
            .offset(MAX_SNAPSHOTS_PER_PROJECT)
        )
    )
    if stale:
        await session.execute(delete(Snapshot).where(Snapshot.id.in_(stale)))
        await session.commit()


@router.get("", response_model=SnapshotListOut)
async def list_snapshots(
    project_id: str,
    session: SessionDep,
    user: CurrentUser,
    settings: SettingsDep,
) -> SnapshotListOut:
    await require_project(project_id, session, user)

    rows = await session.execute(
        select(Snapshot, User)
        .join(User, User.id == Snapshot.created_by_id)
        .where(Snapshot.project_id == project_id)
        .order_by(Snapshot.created_at.desc())
    )

    mode = storage_mode(settings)
    return SnapshotListOut(
        snapshots=[
            SnapshotOut(
                id=snapshot.id,
                project_id=snapshot.project_id,
                blob_url=snapshot.blob_url,
                storage=mode,
                created_at=snapshot.created_at,
                created_by=UserBrief.model_validate(author),
            )
            for snapshot, author in rows.all()
        ]
    )


@router.get("/{snapshot_id}/content", response_model=SnapshotRestoreOut)
async def read_snapshot(
    project_id: str,
    snapshot_id: str,
    session: SessionDep,
    user: CurrentUser,
) -> SnapshotRestoreOut:
    """Fetch one snapshot's canvas document, to restore it.

    Needed because inline snapshots have no URL to fetch from. Blob-backed
    snapshots are proxied through here too, so a browser never needs to reach
    a Blob URL directly and storage stays private.
    """
    await require_project(project_id, session, user)

    snapshot = await session.get(Snapshot, snapshot_id)
    if snapshot is None or snapshot.project_id != project_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Snapshot not found")

    if snapshot.state is not None:
        return SnapshotRestoreOut(
            state=snapshot.state, storage="inline", created_at=snapshot.created_at
        )

    if not snapshot.blob_url:
        raise HTTPException(
            status.HTTP_410_GONE, "Snapshot payload is no longer available"
        )

    async with httpx.AsyncClient(timeout=BLOB_UPLOAD_TIMEOUT_SECONDS) as client:
        response = await client.get(snapshot.blob_url)
    if response.status_code >= 400:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, "Could not read snapshot from storage"
        )

    return SnapshotRestoreOut(
        state=response.text, storage="blob", created_at=snapshot.created_at
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def clear_snapshots(
    project: ProjectEditor,
    session: SessionDep,
) -> None:
    """Clear a project's saved snapshot history. Requires EDITOR or above."""
    await session.execute(delete(Snapshot).where(Snapshot.project_id == project.id))
    await session.commit()


@router.delete("/{snapshot_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_snapshot(
    snapshot_id: str,
    project: ProjectEditor,
    session: SessionDep,
) -> None:
    """Delete one saved snapshot from this project."""
    result = await session.execute(
        delete(Snapshot).where(
            Snapshot.id == snapshot_id,
            Snapshot.project_id == project.id,
        )
    )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Snapshot not found")
    await session.commit()