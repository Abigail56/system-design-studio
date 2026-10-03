"use client";

import type { CanvasNode, CanvasNodeData, EntityAttribute } from "@/lib/canvas";
import { NODE_META } from "@/lib/canvas";

function parseAttributeKey(value?: string): EntityAttribute["key"] {
  const key = value?.toUpperCase().replace(/\s+/g, "");
  if (key === "PK") return "PK";
  if (key === "FK") return "FK";
  if (key === "PK,FK") return "PK, FK";
  return "";
}

export function ComponentPropertiesPanel({
  node,
  canWrite,
  onChange,
  onClose,
}: {
  node: CanvasNode;
  canWrite: boolean;
  onChange: (data: CanvasNodeData) => void;
  onClose: () => void;
}) {
  const update = (field: "label" | "tech" | "description", value: string) => {
    const data = { ...node.data };
    if ((field === "tech" || field === "description") && value.length === 0) {
      delete data[field];
    } else {
      data[field] = value;
    }
    onChange(data);
  };
  const attributesText = (node.data.attributes ?? [])
    .map(({ name, type, key }) => `${name}: ${type}${key ? ` [${key}]` : ""}`)
    .join("\n");
  const updateAttributes = (value: string) => {
    const attributes: EntityAttribute[] = value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?):\s*(.*?)(?:\s+\[(PK(?:,\s*FK)?|FK)\])?$/i);
        return {
          name: match?.[1]?.trim() || line,
          type: match?.[2]?.trim() || "text",
          key: parseAttributeKey(match?.[3]),
        };
      });
    onChange({ ...node.data, attributes: attributes.length ? attributes : undefined });
  };

  return (
    <section
      aria-label="Selected component properties"
      className="rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)]/95 p-4 shadow-[var(--shadow-lg)] backdrop-blur-xl"
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
            <span className="size-2 rounded-full bg-current" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--fg-subtle)]">
              {NODE_META[node.type].label} properties
            </p>
            <p className="truncate text-sm font-semibold">{node.data.label}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close component properties"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-lg text-[var(--fg-subtle)] transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--fg)]"
        >
          ×
        </button>
      </header>

      <div className="grid gap-3">
        <label className="grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
          Component name
          <input
            value={node.data.label}
            disabled={!canWrite}
            maxLength={120}
            onChange={(event) => update("label", event.target.value)}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-70"
          />
        </label>

        <label className="grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
          Technology
          <input
            value={node.data.tech ?? ""}
            disabled={!canWrite}
            maxLength={120}
            onChange={(event) => update("tech", event.target.value)}
            placeholder="e.g. PostgreSQL, Node.js"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-70"
          />
        </label>

        <label className="grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
          Description
          <textarea
            value={node.data.description ?? ""}
            disabled={!canWrite}
            maxLength={1000}
            rows={3}
            onChange={(event) => update("description", event.target.value)}
            placeholder="What does this component do?"
            className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] leading-5 text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-70"
          />
        </label>
      </div>

      {node.type === "entity" ? (
        <label className="mt-3 grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
          Fields
          <textarea
            value={attributesText}
            disabled={!canWrite}
            rows={5}
            onChange={(event) => updateAttributes(event.target.value)}
            placeholder={"id: uuid [PK]\ncustomer_id: uuid [FK]\ncreated_at: timestamp"}
            className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--fg)] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-70"
          />
          <span className="text-[10px] font-normal text-[var(--fg-subtle)]">
            One field per line: name: type [PK or FK]
          </span>
        </label>
      ) : null}

      <p className="mt-3 text-[10px] text-[var(--fg-subtle)]">
        {canWrite
          ? "Changes sync to the canvas and are saved automatically."
          : "You have view-only access to this component."}
      </p>
    </section>
  );
}
