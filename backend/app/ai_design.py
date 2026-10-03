"""Diagram generation and spec writing.

The model is untrusted input. Everything it returns is validated and repaired
here before it can reach a canvas, because a malformed diagram that renders as
a broken graph is worse than an error message.
"""

from __future__ import annotations

import logging
from typing import Any

from app.ai import AIError, complete_text, extract_json

log = logging.getLogger(__name__)

VALID_NODE_TYPES = {"service", "database", "queue", "client", "entity"}
VALID_ERD_KEYS = {"", "PK", "FK", "PK, FK"}

# Ceilings. A runaway generation should fail, not silently produce a canvas
# that takes a browser down to render.
MAX_NODES = 200
MAX_EDGES = 400

DIAGRAM_SYSTEM_PROMPT = """\
You are a staff systems architect producing an architecture diagram as JSON.

Return ONLY a JSON object, no prose and no markdown fence, shaped exactly like:

{
  "nodes": [
    {
      "id": "svc-api-gateway",
      "type": "service",
      "position": { "x": 0, "y": 0 },
      "data": { "label": "API Gateway", "tech": "Kong", "description": "Public entry point" }
    }
  ],
  "edges": [
    { "id": "edge-1", "source": "svc-api-gateway", "target": "db-orders", "label": "reads" }
  ]
}

Rules:
- "type" must be one of: service, database, queue, client.
- Every "id" must be unique across nodes AND edges.
- Every edge's "source" and "target" must be the id of a node in "nodes".
- "position" is in pixels. Lay out left to right by request flow, with at least
  260px between columns and 160px between rows so nothing overlaps.
- Keep it to the components that actually matter. Prefer 6 to 15 nodes.
- "label" is a short human name. "tech" is the concrete technology if there is
  an obvious one, otherwise omit it. "description" is one clause.
- Edge "label" is a short verb phrase: "reads", "writes", "publishes", "calls".
"""

ERD_SYSTEM_PROMPT = """\
You are a data architect producing an entity-relationship diagram as JSON.

Return ONLY a JSON object with "nodes" and "edges". Each node must have a unique
"id", type "entity", a pixel position, and data containing "label", "tech",
"description", and "attributes". Each attribute has "name", "type", and "key"
(one of "", "PK", "FK", "PK, FK"). Edges connect existing entity ids and have
a concise cardinality label such as "1:N", "1:1", or "N:M".

Model a sensible normalized relational schema from the request. Include primary
keys, foreign keys, useful data types, and relationship cardinalities. Avoid
inventing requirements not implied by the request. Use 4 to 12 entities when
appropriate, and position them in a readable grid with at least 280px between
columns and 180px between rows. Keep attribute names concise.
"""

SPEC_SYSTEM_PROMPT = """\
You are a staff engineer writing an implementation spec from an architecture
diagram. Produce GitHub-flavoured markdown and nothing else.

Structure it with these sections, in order, omitting any that would be empty:

# Overview
One paragraph: what the system does and the constraints it is designed around.

# Components
For each node in the diagram, a short subsection: name, responsibility, the
technology if named, and why that technology.

# Data flow
Numbered walkthrough of the main request paths, following the edges.

# Data model
For each database node: the entities it holds and their key relationships.

# Interfaces
For each service node that others call: its endpoints, method and purpose.

# Failure modes
What happens when each queue, dependency or downstream service is unavailable,
and how the design degrades.

# Open questions
Genuine decisions a team would still need to make, as a checklist.

Be specific to the diagram given. Do not invent components that are not in it.
Do not write filler. If the diagram is too sparse to support a section, say so
in Open questions rather than padding.
"""


class ValidationError(ValueError):
    """Model output could not be turned into a renderable diagram."""


def _as_str(value: Any, fallback: str = "") -> str:
    return value if isinstance(value, str) and value.strip() else fallback


def validate_diagram(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce a model response into a diagram the canvas can render.

    Repairs what is safe (missing labels, non-string values, stray types) and
    rejects what is not (duplicate ids, edges to nodes that do not exist).
    Repaired defaults are logged so a persistently sloppy prompt is visible
    rather than silently masked.
    """
    nodes_in = raw.get("nodes")
    edges_in = raw.get("edges")
    if not isinstance(nodes_in, list) or not nodes_in:
        raise ValidationError("Model returned no nodes")
    if not isinstance(edges_in, list):
        edges_in = []

    if len(nodes_in) > MAX_NODES:
        raise ValidationError(f"Model returned {len(nodes_in)} nodes, limit is {MAX_NODES}")

    repaired = 0
    nodes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for index, item in enumerate(nodes_in):
        if not isinstance(item, dict):
            continue

        node_id = _as_str(item.get("id"))
        if not node_id:
            node_id = f"node-{index + 1}"
            repaired += 1
        # Duplicate ids would make React key collisions and ambiguous edges, so
        # the later one is renamed rather than the whole response rejected.
        if node_id in seen_ids:
            suffix = 2
            while f"{node_id}-{suffix}" in seen_ids:
                suffix += 1
            node_id = f"{node_id}-{suffix}"
            repaired += 1
        seen_ids.add(node_id)

        node_type = item.get("type")
        if node_type not in VALID_NODE_TYPES:
            node_type = "service"
            repaired += 1

        data = item.get("data")
        data = data if isinstance(data, dict) else {}
        label = _as_str(data.get("label")) or _as_str(item.get("label"))
        if not label:
            label = "Component"
            repaired += 1

        position = item.get("position")
        position = position if isinstance(position, dict) else {}
        try:
            x = float(position.get("x", 0))
            y = float(position.get("y", 0))
        except (TypeError, ValueError):
            x = float(index * 280)
            y = 0.0
            repaired += 1

        node: dict[str, Any] = {
            "id": node_id,
            "type": node_type,
            # Rounded so React Flow does not accumulate fractional offsets.
            "position": {"x": round(x / 20) * 20, "y": round(y / 20) * 20},
            "data": {"label": label},
        }
        tech = _as_str(data.get("tech"))
        description = _as_str(data.get("description"))
        if tech:
            node["data"]["tech"] = tech
        if description:
            node["data"]["description"] = description
        if node_type == "entity":
            attributes_in = data.get("attributes")
            attributes = []
            if isinstance(attributes_in, list):
                for attribute in attributes_in[:100]:
                    if not isinstance(attribute, dict):
                        continue
                    name = _as_str(attribute.get("name"))
                    field_type = _as_str(attribute.get("type"), "text")
                    key = _as_str(attribute.get("key"))
                    if key not in VALID_ERD_KEYS:
                        key = ""
                        repaired += 1
                    if name:
                        attributes.append(
                            {"name": name, "type": field_type, "key": key}
                        )
            node["data"]["attributes"] = attributes
        nodes.append(node)

    edges: list[dict[str, Any]] = []
    edge_ids: set[str] = set()
    dropped_edges = 0

    for index, item in enumerate(edges_in[:MAX_EDGES]):
        if not isinstance(item, dict):
            continue
        source = _as_str(item.get("source"))
        target = _as_str(item.get("target"))
        # An edge to a node that is not in the diagram renders as a line running
        # off into nothing. Drop it and count it.
        if source not in seen_ids or target not in seen_ids:
            dropped_edges += 1
            continue

        edge_id = _as_str(item.get("id")) or f"edge-{index + 1}"
        if edge_id in seen_ids or edge_id in edge_ids:
            suffix = 2
            while f"{edge_id}-{suffix}" in edge_ids:
                suffix += 1
            edge_id = f"{edge_id}-{suffix}"
            repaired += 1
        edge_ids.add(edge_id)

        edge: dict[str, Any] = {"id": edge_id, "source": source, "target": target}
        label = _as_str(item.get("label"))
        if label:
            edge["label"] = label
        edges.append(edge)

    if repaired or dropped_edges:
        log.warning(
            "diagram validation repaired output: repaired=%d dropped_edges=%d",
            repaired,
            dropped_edges,
        )

    return {"nodes": nodes, "edges": edges}


def _describe_diagram(state: dict[str, Any]) -> str:
    """Render the diagram as text for the model to reason about."""
    lines = []
    for node in state.get("nodes", []):
        data = node.get("data", {})
        tech = f" ({data['tech']})" if data.get("tech") else ""
        description = f" - {data['description']}" if data.get("description") else ""
        attributes = data.get("attributes") or []
        fields = (
            " {" + ", ".join(
                f"{attribute.get('name')} {attribute.get('type')} "
                f"{attribute.get('key', '')}".strip()
                for attribute in attributes
                if isinstance(attribute, dict)
            ) + "}"
            if attributes
            else ""
        )
        lines.append(
            f"- {node['id']} [{node['type']}]: "
            f"{data.get('label')}{tech}{description}{fields}"
        )

    by_id = {n["id"]: n for n in state.get("nodes", [])}
    edges = []
    for edge in state.get("edges", []):
        source = by_id.get(edge.get("source", ""), {})
        target = by_id.get(edge.get("target", ""), {})
        label = f" ({edge['label']})" if edge.get("label") else ""
        edges.append(
            f"- {source.get('data', {}).get('label', edge['source'])} "
            f"--{label or '->'}--> {target.get('data', {}).get('label', edge['target'])}"
        )

    if edges:
        lines.append("\nInteractions:")
        lines.extend(edges)
    return "\n".join(lines) if lines else "(the diagram is empty)"


async def generate_diagram(
    settings,
    prompt: str,
    diagram_type: str = "architecture",
) -> dict[str, Any]:
    """Ask the configured model for an architecture or ERD diagram."""
    if diagram_type not in {"architecture", "erd"}:
        raise ValidationError("Diagram type must be architecture or erd")
    system = ERD_SYSTEM_PROMPT if diagram_type == "erd" else DIAGRAM_SYSTEM_PROMPT
    result = await complete_text(
        settings,
        system=system,
        prompt=(
            f"Design the following {'data model' if diagram_type == 'erd' else 'system'} "
            f"and return the JSON diagram.\n\n"
            f"Request: {prompt}"
        ),
        max_tokens=4000,
        json_mode=True,
    )

    try:
        raw = extract_json(result.text)
    except AIError as exc:
        raise ValidationError(str(exc)) from exc

    diagram = validate_diagram(raw)
    log.info(
        "generated diagram: %d nodes, %d edges (%d prompt tokens)",
        len(diagram["nodes"]),
        len(diagram["edges"]),
        result.input_tokens,
    )
    return diagram


async def generate_spec(settings, state: dict[str, Any], *, extra: str = "") -> str:
    """Ask the model to write an implementation spec from the current diagram."""
    description = _describe_diagram(state)

    prompt = (
        "Write the implementation spec for this architecture diagram.\n\n"
        f"{description}\n"
    )
    if extra:
        prompt += f"\nAdditional context from the team:\n{extra}\n"

    if not state.get("nodes"):
        raise ValidationError(
            "The canvas is empty, so there is nothing to write a spec about"
        )

    result = await complete_text(
        settings,
        system=SPEC_SYSTEM_PROMPT,
        prompt=prompt,
        # Specs are long-form, so a much larger budget than diagram generation.
        max_tokens=8000,
    )
    return result.text.strip()