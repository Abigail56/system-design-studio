"""AI provider access.

Two providers are supported and selected by whichever key is present. The rest
of the app talks to `complete_text` and never to a vendor SDK directly, so
swapping providers is a one-line config change rather than a refactor.

Provider credentials are never logged and never leave the server.
"""

from __future__ import annotations

import json
import logging
import time
from asyncio import Lock
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from app.config import Settings

log = logging.getLogger(__name__)

Provider = Literal["openrouter", "openai", "anthropic", "none"]

# Keep responses short enough to be cheap and specific. Diagram generation wants
# structure more than prose; specs want the opposite.
DEFAULT_MAX_TOKENS = 2000
REQUEST_TIMEOUT_SECONDS = 120.0
MODEL_CACHE_SECONDS = 3600.0

_openrouter_models_cache: tuple[float, list[dict[str, str]]] | None = None
_openrouter_models_lock = Lock()


class AIUnavailableError(RuntimeError):
    """No provider key is configured, so the feature cannot run."""


class AIError(RuntimeError):
    """The provider was reachable but refused or failed."""


@dataclass(frozen=True)
class AIResult:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


async def list_openrouter_models(settings: Settings) -> list[dict[str, str]]:
    """Return the OpenRouter model catalog, cached briefly to avoid repeat calls."""
    if not settings.openrouter_api_key:
        raise AIUnavailableError("OpenRouter is not configured.")

    global _openrouter_models_cache
    now = time.monotonic()
    if _openrouter_models_cache and now - _openrouter_models_cache[0] < MODEL_CACHE_SECONDS:
        return _openrouter_models_cache[1]

    async with _openrouter_models_lock:
        now = time.monotonic()
        if _openrouter_models_cache and now - _openrouter_models_cache[0] < MODEL_CACHE_SECONDS:
            return _openrouter_models_cache[1]

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                )
        except httpx.RequestError as exc:
            raise AIError(f"Could not load OpenRouter models: {exc}") from exc

        if response.status_code >= 400:
            raise AIError(f"OpenRouter returned {response.status_code} while loading models")

        try:
            data = response.json()
            records = data["data"]
            if not isinstance(records, list):
                raise TypeError("model catalog data is not a list")
            models = [
                {"id": item["id"], "name": item.get("name") or item["id"]}
                for item in records
                if isinstance(item, dict)
                and isinstance(item.get("id"), str)
                and item["id"].strip()
                and (
                    not isinstance(item.get("architecture"), dict)
                    or "text"
                    in item["architecture"].get("output_modalities", ["text"])
                )
            ]
        except (KeyError, TypeError, ValueError) as exc:
            raise AIError("OpenRouter returned an invalid model catalog") from exc
        if not models:
            raise AIError("OpenRouter returned an empty model catalog")

        if not any(model["id"] == settings.openrouter_model for model in models):
            models.insert(
                0,
                {"id": settings.openrouter_model, "name": settings.openrouter_model},
            )
        _openrouter_models_cache = (time.monotonic(), models)
        return models


def active_provider(settings: Settings) -> Provider:
    if settings.openrouter_api_key:
        return "openrouter"
    if settings.openai_api_key:
        return "openai"
    if settings.anthropic_api_key:
        return "anthropic"
    return "none"


def provider_status(settings: Settings) -> dict[str, Any]:
    """What the UI needs to decide whether to enable AI controls."""
    provider = active_provider(settings)
    if provider == "openrouter":
        model = settings.openrouter_model
    elif provider == "openai":
        model = settings.openai_model
    elif provider == "anthropic":
        model = settings.anthropic_model
    else:
        model = None
    return {
        "available": provider != "none",
        "provider": None if provider == "none" else provider,
        "model": model,
    }


async def complete_text(
    settings: Settings,
    *,
    system: str,
    prompt: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    json_mode: bool = False,
    model: str | None = None,
) -> AIResult:
    """Single-shot completion. Raises `AIUnavailableError` with no key set."""
    provider = active_provider(settings)
    if provider == "none":
        raise AIUnavailableError(
            "No AI provider is configured. Set OPENROUTER_API_KEY, OPENAI_API_KEY, "
            "or ANTHROPIC_API_KEY in the API environment."
        )

    if provider == "openrouter":
        return await _openrouter(settings, system, prompt, max_tokens, json_mode, model)
    if provider == "openai":
        return await _openai(settings, system, prompt, max_tokens, json_mode)
    return await _anthropic(settings, system, prompt, max_tokens)


async def _openrouter(
    settings: Settings,
    system: str,
    prompt: str,
    max_tokens: int,
    json_mode: bool,
    model: str | None = None,
) -> AIResult:
    body: dict[str, Any] = {
        "model": model or settings.openrouter_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {settings.openrouter_api_key}",
                    "HTTP-Referer": settings.openrouter_http_referer,
                    "X-Title": "Ghost AI",
                },
                json=body,
            )
    except httpx.RequestError as exc:
        raise AIError(f"Could not reach OpenRouter: {exc}") from exc

    if response.status_code >= 400:
        detail = response.text[:400]
        raise AIError(f"OpenRouter returned {response.status_code}: {detail}")

    try:
        data = response.json()
        text = data["choices"][0]["message"]["content"]
        if not isinstance(text, str):
            raise TypeError("completion content is not text")
        usage = data.get("usage") or {}
        if not isinstance(usage, dict):
            raise TypeError("completion usage is invalid")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise AIError("OpenRouter returned an invalid chat completion") from exc

    return AIResult(
        text=text,
        model=data.get("model", model or settings.openrouter_model),
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
    )


async def _openai(
    settings: Settings,
    system: str,
    prompt: str,
    max_tokens: int,
    json_mode: bool,
) -> AIResult:
    body: dict[str, Any] = {
        "model": settings.openai_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
    }
    if json_mode:
        # Not every model supports response_format; a 400 here would be opaque,
        # so the instruction in the system prompt carries the contract and this
        # is only best-effort.
        body["response_format"] = {"type": "json_object"}

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json=body,
        )

    if response.status_code >= 400:
        # Truncate the provider's own error so a long payload cannot flood logs.
        detail = response.text[:400]
        raise AIError(f"OpenAI returned {response.status_code}: {detail}")

    data = response.json()
    usage = data.get("usage") or {}
    return AIResult(
        text=data["choices"][0]["message"]["content"] or "",
        model=data.get("model", settings.openai_model),
        input_tokens=usage.get("prompt_tokens", 0),
        output_tokens=usage.get("completion_tokens", 0),
    )


async def _anthropic(
    settings: Settings,
    system: str,
    prompt: str,
    max_tokens: int,
) -> AIResult:
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": settings.anthropic_model,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
            },
        )

    if response.status_code >= 400:
        detail = response.text[:400]
        raise AIError(f"Anthropic returned {response.status_code}: {detail}")

    data = response.json()
    # Anthropic returns a list of content blocks; text blocks carry the answer.
    text = "".join(
        block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
    )
    usage = data.get("usage") or {}
    return AIResult(
        text=text,
        model=data.get("model", settings.anthropic_model),
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
    )


def extract_json(text: str) -> dict[str, Any]:
    """Pull a JSON object out of a model response.

    Models wrap JSON in prose or fences even when asked not to, so this strips
    a fenced block if present and then finds the outermost braces. Raising here
    is correct: the caller records the failure on the task rather than writing a
    half-parsed diagram to the canvas.
    """
    candidate = text.strip()

    if "```" in candidate:
        parts = candidate.split("```")
        # Alternating prose / fenced block; take the first block with braces.
        for part in parts[1:]:
            cleaned = part.removeprefix("json").strip()
            if cleaned.startswith("{"):
                candidate = cleaned
                break

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise AIError("Model response contained no JSON object")

    try:
        parsed = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError as exc:
        raise AIError(f"Model returned malformed JSON: {exc}") from exc

    if not isinstance(parsed, dict):
        raise AIError("Model returned JSON that was not an object")
    return parsed