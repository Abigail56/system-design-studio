"use client";

import { useState } from "react";

import { NODE_META, NODE_TYPES, type NodeType } from "@/lib/canvas";

const ICONS = {
  service: "M2 3h20v8H2zM2 13h20v8H2zM6 7h.01M6 17h.01",
  database:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  queue: "m12 2 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 17l9 5 9-5",
  client: "M2 3h20v14H2zM8 21h8M12 17v4",
  entity: "M3 4h18v16H3zM3 9h18M9 9v11M15 9v11",
} as const;

/**
 * Palette of component kinds.
 *
 * Supports both drag-to-canvas and click-then-click-to-place. Drag alone is not
 * usable with a trackpad, and click-to-place is also what makes the canvas
 * reachable by keyboard.
 */
export function NodePalette({
  disabled,
  pendingKind,
  onPickKind,
  onDragStart,
}: {
  disabled: boolean;
  pendingKind: NodeType | null;
  onPickKind: (kind: NodeType | null) => void;
  onDragStart: (event: React.DragEvent, kind: NodeType) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <aside
      aria-label="Components"
      className="absolute left-5 top-5 z-10 w-44 rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)]/95 p-3 shadow-[var(--shadow)] backdrop-blur"
    >
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls="component-palette-list"
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between rounded-lg px-1.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
      >
        <span>Components</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={`size-3.5 transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      {isOpen ? (
        <>
          <ul id="component-palette-list" className="mt-2 space-y-1">
            {NODE_TYPES.map((kind) => {
              const meta = NODE_META[kind];
              const active = pendingKind === kind;
              return (
                <li key={kind}>
                  <button
                    type="button"
                    draggable={!disabled}
                    disabled={disabled}
                    onDragStart={(event) => onDragStart(event, kind)}
                    onClick={() => onPickKind(active ? null : kind)}
                    aria-pressed={active}
                    title={disabled ? "You have view-only access" : meta.description}
                    className={`flex w-full cursor-grab items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? "bg-[var(--accent)]/10 ring-1 ring-[var(--accent)]"
                        : "hover:bg-[var(--bg)]"
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 opacity-80"
                    >
                      <path d={ICONS[kind]} />
                    </svg>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{meta.label}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-[var(--fg-muted)]">
                        {meta.description}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {disabled ? (
            <p className="mt-2 border-t border-[var(--border)] px-1 pt-2 text-[10px] leading-relaxed text-[var(--fg-muted)]">
              View-only. Ask an owner for edit access.
            </p>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}