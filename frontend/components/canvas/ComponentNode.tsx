"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { DatabaseIcon, LayersIcon, MonitorIcon, ServerIcon } from "@/components/icons";
import { NODE_META, type NodeType } from "@/lib/canvas";

/**
 * The four component kinds a diagram can hold.
 *
 * Rendered by kind rather than as four separate components: the differences are
 * an icon and a colour, and splitting them would mean four files that must all
 * be kept in sync whenever the shared node chrome changes.
 */

const ICONS = {
  service: ServerIcon,
  database: DatabaseIcon,
  queue: LayersIcon,
  client: MonitorIcon,
  entity: DatabaseIcon,
} as const;

/** React Flow wraps data in a record; this narrows it back to our shape. */
type CanvasNodeData = {
  kind: NodeType;
  label: string;
  tech?: string;
  description?: string;
  attributes?: import("@/lib/canvas").EntityAttribute[];
  onLabelChange?: (id: string, label: string) => void;
  readOnly?: boolean;
};

export function ComponentNode({ id, data, selected }: NodeProps) {
  const {
    label,
    tech,
    description,
    attributes,
    onLabelChange,
    readOnly,
    kind,
  } = data as CanvasNodeData;
  const meta = NODE_META[kind];
  const Icon = ICONS[kind];

  return (
    <div
      className={`min-w-48 rounded-xl border ${meta.accent} shadow-[var(--shadow-sm)] transition-shadow duration-150 ${
        selected ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg)]" : ""
      }`}
    >
      {/* Four handles so a node can source on any side; React Flow picks the
          closest valid one when an edge is dropped near it. */}
      <Handle type="target" position={Position.Left} id="left" />
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />

      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-md ${meta.dot}/15`}>
          <Icon className={`size-3.5 ${meta.dot} opacity-90`} aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          {readOnly ? (
            <p className="truncate font-[family-name:var(--font-display)] text-[13px] font-semibold leading-snug tracking-tight">
              {label}
            </p>
          ) : (
            <input
              value={label}
              onChange={(event) => onLabelChange?.(id, event.target.value)}
              aria-label="Component name"
              // Stops a drag on the node from starting while editing the name.
              onMouseDown={(event) => event.stopPropagation()}
              className="w-full truncate bg-transparent font-[family-name:var(--font-display)] text-[13px] font-semibold leading-snug tracking-tight outline-none"
            />
          )}

          {tech ? (
            <p className="mt-1 font-mono text-[10px] leading-none text-[var(--fg-subtle)]">
              {tech}
            </p>
          ) : null}

          {description ? (
            <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-[var(--fg-muted)]">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {kind === "entity" && attributes?.length ? (
        <div className="border-t border-[var(--border)]/80 px-3 py-1.5">
          {attributes.slice(0, 8).map((attribute) => (
            <div
              key={`${attribute.name}:${attribute.type}`}
              className="flex items-center gap-2 py-1 text-[10px]"
            >
              <span className="w-7 shrink-0 font-semibold text-[var(--accent)]">
                {attribute.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--fg)]">
                {attribute.name}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-[var(--fg-subtle)]">
                {attribute.type}
              </span>
            </div>
          ))}
          {attributes.length > 8 ? (
            <p className="pt-1 text-[9px] text-[var(--fg-subtle)]">
              +{attributes.length - 8} more fields
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}