"""AI endpoint behaviour and diagram validation.

No provider key is needed for most of these: the interesting logic is what the
API does when the model is missing, when the model is unavailable, and when the
model returns something malformed. All three are testable without a key.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from tests.conftest import as_user

async def make_project(client, name="AI"):
    response = await client.post("/v1/projects", json={"name": name}, headers=as_user("owner_a"))
    assert response.status_code == 201, response.text
    return response.json()["project"]


def test_ai_prompts_accept_configured_character_limits_and_reject_longer_values():
    from app.routers.ai import ChatRequest
    from app.schemas import GenerateRequest

    generation_prompt = "x" * 30000
    chat_message = "x" * 4500
    GenerateRequest(project_id="project", prompt=generation_prompt)
    ChatRequest(project_id="project", message=chat_message)

    with pytest.raises(ValidationError):
        GenerateRequest(project_id="project", prompt=generation_prompt + "x")
    with pytest.raises(ValidationError):
        ChatRequest(project_id="project", message=chat_message + "x")


async def test_chat_uses_default_model_and_current_canvas(client, session, monkeypatch):
    from app.ai import AIResult
    from app.config import get_settings
    from app.models import Project, Snapshot

    project = await make_project(client)
    project_row = await session.get(Project, project["id"])
    assert project_row is not None
    session.add(
        Snapshot(
            project_id=project["id"],
            state=json.dumps(
                {
                    "nodes": [
                        {
                            "id": "api",
                            "type": "service",
                            "data": {"label": "API Gateway"},
                        }
                    ],
                    "edges": [],
                }
            ),
            created_by_id=project_row.owner_id,
        )
    )
    await session.commit()

    default_model = "openai/gpt-4o-mini"
    monkeypatch.setattr(get_settings(), "openrouter_model", default_model)

    async def available_models(_settings):
        return [{"id": default_model, "name": "GPT-4o mini"}]

    captured = {}

    async def answer(_settings, *, system, prompt, max_tokens, model):
        captured.update(system=system, prompt=prompt, model=model, max_tokens=max_tokens)
        return AIResult("The API Gateway is the public entry point.", model)

    monkeypatch.setattr("app.routers.ai.active_provider", lambda _settings: "openrouter")
    monkeypatch.setattr("app.routers.ai.list_openrouter_models", available_models)
    monkeypatch.setattr("app.routers.ai.complete_text", answer)

    response = await client.post(
        "/v1/ai/chat",
        json={
            "project_id": project["id"],
            "message": "What does the API Gateway do?",
            "history": [],
            "models": [],
        },
        headers=as_user("owner_a"),
    )

    assert response.status_code == 200, response.text
    assert "The API Gateway is the public entry point." in response.text
    assert "API Gateway" in captured["prompt"]
    assert "What does the API Gateway do?" in captured["prompt"]
    assert captured["model"] == default_model


# --- status ---------------------------------------------------------------


async def test_status_reports_unavailable_without_a_key(client, monkeypatch):
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "openai_api_key", None, raising=False)
    monkeypatch.setattr(settings, "anthropic_api_key", None, raising=False)
    monkeypatch.setattr(settings, "openrouter_api_key", None, raising=False)

    response = await client.get("/v1/ai/status", headers=as_user("owner_a"))
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["provider"] is None


async def test_status_reports_the_configured_provider(client, monkeypatch):
    from app.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "openrouter_api_key", None, raising=False)
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-not-real", raising=False)

    response = await client.get("/v1/ai/status", headers=as_user("owner_a"))
    assert response.json() == {
        "available": True,
        "provider": "openai",
        "model": settings.openai_model,
    }


def test_erd_diagram_validation_preserves_entities_and_keys():
    from app.ai_design import validate_diagram

    result = validate_diagram(
        {
            "nodes": [
                {
                    "id": "user",
                    "type": "entity",
                    "label": "User",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "kind": "entity",
                        "label": "User",
                        "attributes": [
                            {"name": "id", "type": "UUID", "key": "PK"},
                            {"name": "organization_id", "type": "UUID", "key": "FK"},
                        ],
                    },
                }
            ],
            "edges": [],
        }
    )

    assert result["nodes"][0]["data"]["attributes"] == [
        {"name": "id", "type": "UUID", "key": "PK"},
        {"name": "organization_id", "type": "UUID", "key": "FK"},
    ]


def test_provider_status_reports_openrouter():
    from app.ai import provider_status
    from app.config import Settings

    settings = Settings(
        database_url="postgresql://localhost/ghost",
        clerk_secret_key="sk_test_x",
        openrouter_api_key="sk-or-test",
    )
    assert provider_status(settings) == {
        "available": True,
        "provider": "openrouter",
        "model": settings.openrouter_model,
    }


async def test_complete_text_calls_openrouter(monkeypatch):
    import httpx

    from app.ai import complete_text
    from app.config import Settings

    settings = Settings(
        database_url="postgresql://localhost/ghost",
        clerk_secret_key="sk_test_x",
        openrouter_api_key="sk-or-test",
        openrouter_model="openai/gpt-4o-mini",
        openrouter_http_referer="https://ghost.example",
    )
    captured = {}

    async def fake_post(_client, url, *, headers, json):
        captured.update(url=url, headers=headers, body=json)
        return httpx.Response(
            200,
            json={
                "model": "openai/gpt-4o-mini",
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await complete_text(
        settings,
        system="Be helpful",
        prompt="Say hello",
        max_tokens=10,
        json_mode=True,
        model="anthropic/claude-sonnet-4",
    )

    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["headers"] == {
        "Authorization": "Bearer sk-or-test",
        "HTTP-Referer": "https://ghost.example",
        "X-Title": "Ghost AI",
    }
    assert captured["body"] == {
        "model": "anthropic/claude-sonnet-4",
        "messages": [
            {"role": "system", "content": "Be helpful"},
            {"role": "user", "content": "Say hello"},
        ],
        "max_tokens": 10,
        "response_format": {"type": "json_object"},
    }
    assert result.text == "hello"
    assert result.input_tokens == 3
    assert result.output_tokens == 2


async def test_openrouter_model_catalog_is_cached(monkeypatch):
    import httpx

    from app import ai as ai_module
    from app.config import Settings

    settings = Settings(
        database_url="postgresql://localhost/ghost",
        clerk_secret_key="sk_test_x",
        openrouter_api_key="sk-or-test",
        openrouter_model="openai/gpt-4o-mini",
    )
    calls = 0

    async def fake_get(_client, url, *, headers):
        nonlocal calls
        calls += 1
        assert url == "https://openrouter.ai/api/v1/models"
        assert headers == {"Authorization": "Bearer sk-or-test"}
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "anthropic/claude-sonnet-4", "name": "Claude Sonnet"},
                    {"id": "google/gemini-flash", "name": "Gemini Flash"},
                ]
            },
        )

    monkeypatch.setattr(ai_module, "_openrouter_models_cache", None)
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    first = await ai_module.list_openrouter_models(settings)
    second = await ai_module.list_openrouter_models(settings)

    assert first == second
    assert first == [
        {"id": "openai/gpt-4o-mini", "name": "openai/gpt-4o-mini"},
        {"id": "anthropic/claude-sonnet-4", "name": "Claude Sonnet"},
        {"id": "google/gemini-flash", "name": "Gemini Flash"},
    ]
    assert calls == 1


async def test_status_requires_authentication(client):
    assert (await client.get("/v1/ai/status")).status_code == 401


# --- generate -------------------------------------------------------------


async def test_generate_without_a_provider_key_is_503(client, monkeypatch):
    """The UI needs a distinguishable error, not a generic failure."""
    from app.ai import AIUnavailableError

    project = await make_project(client)

    async def unavailable(*_args, **_kwargs):
        raise AIUnavailableError("No AI provider is configured")

    monkeypatch.setattr("app.ai_design.complete_text", unavailable)

    response = await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "Design a URL shortener"},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 503
    assert "provider" in response.json()["error"].lower()


async def test_failed_generation_is_recorded_on_the_task(client, monkeypatch, session):
    from app.ai import AIUnavailableError
    from app.models import AITask, AITaskStatus

    project = await make_project(client)

    async def unavailable(*_args, **_kwargs):
        raise AIUnavailableError("No AI provider is configured")

    monkeypatch.setattr("app.ai_design.complete_text", unavailable)

    await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "Design a URL shortener"},
        headers=as_user("owner_a"),
    )

    from sqlalchemy import select

    task = await session.scalar(select(AITask))
    assert task is not None
    assert task.status == AITaskStatus.FAILED
    assert "provider" in (task.error or "").lower()


async def test_generate_rejects_a_non_member(client):
    project = await make_project(client)
    response = await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "x"},
        headers=as_user("intruder"),
    )
    assert response.status_code == 404


async def test_generate_rejects_an_empty_prompt(client):
    project = await make_project(client)
    response = await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "   "},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 422


async def test_generate_returns_a_validated_diagram(client, monkeypatch):
    """Garbage in, repaired diagram out."""
    from app.ai import AIResult

    project = await make_project(client)

    async def fake(*_args, **_kwargs):
        return AIResult(
            text=json.dumps(
                {
                    "nodes": [
                        {"id": "a", "type": "service", "position": {"x": 0, "y": 0},
                         "data": {"label": "API", "tech": "Kong"}},
                        {"id": "a", "type": "database", "position": {"x": 300.7, "y": 0},
                         "data": {"label": "DB"}},
                        {"type": "bogus", "data": {}},
                    ],
                    "edges": [
                        {"id": "e1", "source": "a", "target": "a-2"},
                        {"id": "e2", "source": "a", "target": "does-not-exist"},
                    ],
                }
            ),
            model="test",
        )

    monkeypatch.setattr("app.ai_design.complete_text", fake)

    response = await client.post(
        "/v1/ai/generate",
        json={"project_id": project["id"], "prompt": "Design something"},
        headers=as_user("owner_a"),
    )
    assert response.status_code == 200, response.text

    body = response.json()
    ids = [n["id"] for n in body["nodes"]]
    # Duplicate renamed, not dropped: the node was real, only its id collided.
    assert len(set(ids)) == len(ids) == 3
    # Unknown type coerced to service; missing label given a placeholder.
    assert body["nodes"][2]["type"] == "service"
    assert body["nodes"][2]["data"]["label"]
    # Positions snapped to the grid.
    assert body["nodes"][1]["position"]["x"] % 20 == 0
    # Edge to a missing node dropped; the real one kept.
    assert [e["id"] for e in body["edges"]] == ["e1"]


# --- diagram validation (unit) -------------------------------------------


def test_validate_rejects_a_response_with_no_nodes():
    from app.ai_design import ValidationError, validate_diagram

    with pytest.raises(ValidationError):
        validate_diagram({"nodes": [], "edges": []})


def test_validate_rejects_more_nodes_than_the_limit():
    from app.ai_design import MAX_NODES, ValidationError, validate_diagram

    payload = {"nodes": [{"id": f"n{i}"} for i in range(MAX_NODES + 1)], "edges": []}
    with pytest.raises(ValidationError):
        validate_diagram(payload)


def test_validate_accepts_a_minimal_but_valid_diagram():
    from app.ai_design import validate_diagram

    result = validate_diagram(
        {"nodes": [{"id": "only", "type": "queue", "data": {"label": "Q"}}], "edges": []}
    )
    assert result["nodes"][0]["type"] == "queue"
    assert result["nodes"][0]["data"]["label"] == "Q"


def test_architecture_layout_follows_dependencies_and_separates_branches():
    from app.ai_design import layout_diagram

    state = {
        "nodes": [
            {"id": "db", "type": "database", "position": {"x": 0, "y": 0}},
            {"id": "api", "type": "service", "position": {"x": 0, "y": 0}},
            {"id": "web", "type": "client", "position": {"x": 0, "y": 0}},
            {"id": "queue", "type": "queue", "position": {"x": 0, "y": 0}},
        ],
        "edges": [
            {"id": "web-api", "source": "web", "target": "api"},
            {"id": "api-db", "source": "api", "target": "db"},
            {"id": "api-queue", "source": "api", "target": "queue"},
        ],
    }

    result = layout_diagram(state, "architecture")
    positions = {node["id"]: node["position"] for node in result["nodes"]}

    assert positions["web"]["x"] < positions["api"]["x"]
    assert positions["api"]["x"] < positions["db"]["x"]
    assert positions["api"]["x"] < positions["queue"]["x"]
    assert positions["db"]["x"] == positions["queue"]["x"]
    assert positions["db"]["y"] != positions["queue"]["y"]


def test_erd_layout_places_entities_in_a_spaced_grid():
    from app.ai_design import layout_diagram

    state = {
        "nodes": [
            {"id": f"entity-{index}", "type": "entity", "position": {"x": 0, "y": 0}}
            for index in range(5)
        ],
        "edges": [],
    }

    result = layout_diagram(state, "erd")
    positions = {node["id"]: node["position"] for node in result["nodes"]}

    assert positions["entity-0"] == {"x": 0, "y": 0}
    assert positions["entity-1"]["x"] == 440
    assert positions["entity-2"]["x"] == 880
    assert positions["entity-3"]["y"] > positions["entity-0"]["y"]
    assert len(set((point["x"], point["y"]) for point in positions.values())) == 5


def test_extract_json_ignores_code_fences_and_prose():
    from app.ai import extract_json

    text = 'Here you go:\n```json\n{"nodes": [], "edges": []}\n```\nHope that helps.'
    assert extract_json(text) == {"nodes": [], "edges": []}


def test_extract_json_rejects_a_response_with_no_object():
    from app.ai import AIError, extract_json

    with pytest.raises(AIError):
        extract_json("I could not produce a diagram.")


def test_extract_json_rejects_truncated_output():
    """A cut-off response is the most common real failure, and must not parse."""
    from app.ai import AIError, extract_json

    with pytest.raises(AIError):
        extract_json('{"nodes": [{"id": "a"')


# --- spec -----------------------------------------------------------------


async def test_spec_with_an_empty_canvas_is_refused(client, monkeypatch):
    """Nothing to describe means a bad request, not a fabricated spec."""
    project = await make_project(client)

    async def never_called(*_args, **_kwargs):
        raise AssertionError("should not reach the model with an empty canvas")

    monkeypatch.setattr("app.ai_design.complete_text", never_called)

    response = await client.post(
        "/v1/ai/spec", json={"project_id": project["id"]}, headers=as_user("owner_a")
    )
    assert response.status_code == 502
    assert "empty" in response.json()["error"].lower()