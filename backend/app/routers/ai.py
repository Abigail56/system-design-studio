"""AI endpoints: chat, diagram generation, spec writing.

Long work runs inline here rather than in a separate worker queue: with no
Trigger.dev deployment configured, a background job would be a queue nothing
drains. `POST /generate` and `POST /spec` still record an `ai_task` row, so the
history and rate limits work the same way they will once a worker exists.

The tradeoff is explicit: a generation request holds a connection for the length
of the model call. That is fine for a handful of users and wrong for a hundred,
which is exactly the point at which the queue should move out.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse
import httpx
from pydantic import BaseModel, Field, field_validator
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import func, select

from app import ai_design
from app.ai import (
    AIError,
    AIUnavailableError,
    active_provider,
    complete_text,
    list_openrouter_models,
    provider_status,
)
from app.deps import CurrentUser, SessionDep, SettingsDep, enforce, require_project
from app.models import AITask, AITaskStatus, AITaskType, Snapshot
from app.schemas import AITaskEnvelope, AITaskOut, GenerateRequest, SpecRequest


def _validate(schema: type[GenerateRequest] | type[SpecRequest], payload: dict):
    """Validate a loosely-typed body into a schema, or raise 422.

    FastAPI's own validation runs before the handler, so these bodies arrive as
    plain dicts. Calling `model_validate` without catching leaves a pydantic
    ValidationError escaping as a 500 rather than the 422 the client expects.
    """
    try:
        return schema.model_validate(payload)
    except PydanticValidationError as exc:
        first = exc.errors()[0] if exc.errors() else None
        message = first.get("msg", "Invalid request body") if first else "Invalid request body"
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, message) from exc

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai"])

CHAT_SYSTEM_PROMPT = """\
You are a systems architect embedded in a collaborative diagram tool. You are
helping a team that is designing a system together on a shared canvas.

You will be given the current diagram as context. Refer to components by the
names shown there.

Be direct and concrete. Prefer specifics over generalities: name technologies,
call out the failure modes you can see, and say when a design has a problem.
Keep answers to a few short paragraphs unless asked for more. Use markdown for
structure.
"""

# A project may only have this many tasks in flight at once, per type. Distinct
# from the hourly rate limit: this bounds concurrent work, not total spend.
MAX_INFLIGHT_PER_TYPE = 3


async def _claim_slot(
    session: SessionDep,
    project: Project,
    task_type: AITaskType,
) -> None:
    """Raise 429 if this project already has too many tasks of `task_type` running.

    Counting running rows and then inserting is check-then-act. Without a lock,
    concurrent requests all read the same count before any of them writes, so the
    cap silently never engages, which is exactly when it matters. A
    transaction-scoped advisory lock serialises the pair per project; the window
    is two statements wide, so holding it that briefly is fine.

    Distinct from the hourly rate limit: this bounds concurrent work, not total
    spend.
    """
    key = int.from_bytes(hashlib.sha256(project.id.encode()).digest()[:8], "big", signed=True)
    await session.execute(select(func.pg_advisory_xact_lock(key)))

    in_flight = await session.scalar(
        select(func.count())
        .select_from(AITask)
        .where(
            AITask.project_id == project.id,
            AITask.type == task_type,
            AITask.status.in_([AITaskStatus.QUEUED, AITaskStatus.RUNNING]),
        )
    )
    if (in_flight or 0) >= MAX_INFLIGHT_PER_TYPE:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"You already have {MAX_INFLIGHT_PER_TYPE} {task_type.value} tasks in progress",
        )


class ChatMessageIn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    project_id: str
    message: str = Field(min_length=1, max_length=4500)
    #: Recent turns, oldest first. Bounded server-side.
    history: list[ChatMessageIn] = Field(default_factory=list, max_length=20)
    models: list[str] = Field(default_factory=list, max_length=3)

    @field_validator("models")
    @classmethod
    def models_must_be_unique(cls, models: list[str]) -> list[str]:
        if len(models) != len(set(models)):
            raise ValueError("Selected models must be unique")
        return models


class StatusOut(BaseModel):
    """Whether AI features can run at all, so the UI can disable cleanly."""

    available: bool
    provider: str | None
    model: str | None


class ModelOption(BaseModel):
    id: str
    name: str


class DiagramOut(BaseModel):
    nodes: list[dict]
    edges: list[dict]


class SpecOut(BaseModel):
    spec: str


@router.get("/status", response_model=StatusOut)
async def ai_status(_user: CurrentUser, settings: SettingsDep) -> StatusOut:
    """Whether AI is usable. Authenticated because it reports configuration."""
    return StatusOut(
        **provider_status(settings),
    )


@router.get("/models", response_model=list[ModelOption])
async def ai_models(_user: CurrentUser, settings: SettingsDep) -> list[ModelOption]:
    """Expose OpenRouter's available chat models without exposing its key."""
    if active_provider(settings) != "openrouter":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Model selection requires OpenRouter to be the active AI provider.",
        )
    try:
        models = await list_openrouter_models(settings)
    except AIUnavailableError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    except AIError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    return [ModelOption(**model) for model in models]


@router.get("/tasks/{task_id}", response_model=AITaskEnvelope)
async def get_task(task_id: str, session: SessionDep, user: CurrentUser) -> AITaskEnvelope:
    task = await session.get(AITask, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Task not found")

    await require_project(task.project_id, session, user)
    return AITaskEnvelope(task=AITaskOut.model_validate(task))


@router.post("/chat")
async def chat(
    payload: ChatRequest,
    session: SessionDep,
    settings: SettingsDep,
    user: CurrentUser,
) -> StreamingResponse:
    """Stream an answer about the current diagram, as server-sent events.

    Any project member may chat, including viewers: asking what a component
    does is not an edit.
    """
    project, _role = await require_project(payload.project_id, session, user)
    await enforce("ai:chat", session, user)
    provider = active_provider(settings)
    models = payload.models or ([settings.openrouter_model] if provider == "openrouter" else [])
    if models and provider != "openrouter":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Model selection requires OpenRouter to be the active AI provider.",
        )
    if provider == "openrouter":
        try:
            available_models = {
                model["id"] for model in await list_openrouter_models(settings)
            }
        except AIUnavailableError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
        except AIError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
        if any(model not in available_models for model in models):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "One or more selected models are not available through OpenRouter.",
            )

    # The most recent snapshot is the closest thing to "what the team is looking
    # at right now" that does not require a liveblocks round trip.
    snapshot = await session.scalar(
        select(Snapshot)
        .where(Snapshot.project_id == project.id)
        .order_by(Snapshot.created_at.desc())
    )

    context = "The canvas is currently empty."
    if snapshot and snapshot.state:
        try:
            state = json.loads(snapshot.state)
            context = ai_design._describe_diagram(state)
        except (json.JSONDecodeError, AttributeError):
            # A corrupt snapshot must not break chat; fall back to no context.
            log.warning("could not parse snapshot for chat context", exc_info=True)

    history = "\n".join(f"{m.role}: {m.content}" for m in payload.history[-10:])
    prompt = (
        f"Current diagram ({project.name}):\n{context}\n\n"
        f"Conversation so far:\n{history or '(none)'}\n\n"
        f"user: {payload.message}"
    )

    async def events():
        """Yields SSE frames. Errors mid-stream become an `error` event, since
        the status line has already been sent by then."""
        async def run_model(model: str | None, queue: asyncio.Queue) -> None:
            try:
                result = await complete_text(
                    settings,
                    system=CHAT_SYSTEM_PROMPT,
                    prompt=prompt,
                    max_tokens=2000,
                    model=model,
                )
                await queue.put((model or result.model, result.text, None))
            except (AIUnavailableError, AIError) as exc:
                log.warning("chat failed for model %s", model or provider, exc_info=True)
                await queue.put((model or provider, "", str(exc)))
            except (httpx.RequestError, KeyError, IndexError, TypeError, ValueError) as exc:
                log.warning(
                    "AI provider returned an invalid response for model %s",
                    model or provider,
                    exc_info=True,
                )
                await queue.put(
                    (model or provider, "", "The AI provider returned an invalid response.")
                )

        selected_models: list[str | None] = models if models else [None]
        queue: asyncio.Queue = asyncio.Queue()
        tasks = [asyncio.create_task(run_model(model, queue)) for model in selected_models]
        try:
            for _ in tasks:
                model, text, error = await queue.get()
                if error:
                    yield f"data: {json.dumps({'type': 'model_error', 'model': model, 'error': error})}\n\n"
                    continue
                for start in range(0, len(text), 240):
                    chunk = text[start : start + 240]
                    yield f"data: {json.dumps({'type': 'delta', 'model': model, 'text': chunk})}\n\n"
                yield f"data: {json.dumps({'type': 'model_done', 'model': model})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            # Without this nginx and some proxies buffer the whole response,
            # which defeats streaming entirely.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/generate", response_model=DiagramOut)
async def generate(
    payload: dict,
    session: SessionDep,
    settings: SettingsDep,
    user: CurrentUser,
) -> DiagramOut:
    """Generate a diagram from a prompt and return it for the client to apply."""
    request = _validate(GenerateRequest, payload)
    await enforce("ai:generate", session, user)
    project, _role = await require_project(request.project_id, session, user)
    await _claim_slot(session, project, AITaskType.GENERATE_DESIGN)

    task = AITask(
        project_id=project.id,
        created_by_id=user.id,
        type=AITaskType.GENERATE_DESIGN,
        status=AITaskStatus.RUNNING,
        prompt=f"[configured AI; {request.diagram_type}] {request.prompt}",
    )
    session.add(task)
    # Commit the RUNNING claim before the long call, not after. The in-flight
    # guard counts RUNNING rows, and a row that is only committed once the model
    # returns is invisible to every concurrent request, so the cap would never
    # engage exactly when several people generate at once.
    await session.commit()

    try:
        diagram = await ai_design.generate_diagram(
            settings,
            request.prompt,
            diagram_type=request.diagram_type,
        )
    except (
        AIUnavailableError,
        AIError,
        ai_design.ValidationError,
    ) as exc:
        task.status = AITaskStatus.FAILED
        task.error = str(exc)[:4000]
        await session.commit()
        # 503 for "no key", 502 for "the model did not produce a usable diagram".
        code = status.HTTP_503_SERVICE_UNAVAILABLE if isinstance(
            exc, AIUnavailableError
        ) else status.HTTP_502_BAD_GATEWAY
        raise HTTPException(code, str(exc))

    task.status = AITaskStatus.COMPLETED
    task.result = diagram
    await session.commit()

    return DiagramOut(**diagram)


@router.post("/spec", response_model=SpecOut)
async def spec(
    payload: dict,
    session: SessionDep,
    settings: SettingsDep,
    user: CurrentUser,
) -> SpecOut:
    """Write a markdown implementation spec from the current diagram."""
    request = _validate(SpecRequest, payload)
    await enforce("ai:spec", session, user)
    project, _role = await require_project(request.project_id, session, user)
    await _claim_slot(session, project, AITaskType.GENERATE_SPEC)

    task = AITask(
        project_id=project.id,
        created_by_id=user.id,
        type=AITaskType.GENERATE_SPEC,
        status=AITaskStatus.RUNNING,
        prompt="Write an implementation spec",
    )
    session.add(task)
    # Same reason as /generate: the claim must be visible to concurrent callers.
    await session.commit()

    # Read the newest snapshot rather than the live canvas: it is the last
    # agreed state, and it avoids coupling the API to the realtime transport.
    snapshot = await session.scalar(
        select(Snapshot)
        .where(Snapshot.project_id == project.id)
        .order_by(Snapshot.created_at.desc())
    )

    state = {"nodes": [], "edges": []}
    if snapshot and snapshot.state:
        try:
            state = json.loads(snapshot.state)
        except json.JSONDecodeError:
            log.warning("could not parse snapshot for spec generation")

    try:
        markdown = await ai_design.generate_spec(settings, state)
    except (AIUnavailableError, AIError, ai_design.ValidationError) as exc:
        task.status = AITaskStatus.FAILED
        task.error = str(exc)[:4000]
        await session.commit()
        code = (
            status.HTTP_503_SERVICE_UNAVAILABLE
            if isinstance(exc, AIUnavailableError)
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(code, str(exc))

    task.status = AITaskStatus.COMPLETED
    task.result = {"spec": markdown}
    await session.commit()

    return SpecOut(spec=markdown)