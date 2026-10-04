"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

const BOARD_WIDTH = 1600;
const BOARD_HEIGHT = 1000;
const COLORS = ["#e8eaed", "#f87171", "#fbbf24", "#4ade80", "#38bdf8", "#a78bfa", "#f472b6"];
const STORAGE_PREFIX = "system-design-studio:sketchboard:";
const TOOL_NAMES = ["select", "freehand", "rectangle", "ellipse", "arrow", "text", "eraser"] as const;

type Tool = (typeof TOOL_NAMES)[number];
type Point = { x: number; y: number };
type SketchElement =
  | { id: string; type: "path"; points: Point[]; color: string; strokeWidth: number }
  | {
      id: string;
      type: "rectangle" | "ellipse";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      strokeWidth: number;
    }
  | { id: string; type: "text"; x: number; y: number; text: string; color: string };

type TextDraft = { point: Point; value: string };
type DragState = { id: string; point: Point; original: SketchElement[] };

const TOOL_LABELS: Record<Tool, string> = {
  select: "Select and move",
  freehand: "Freehand draw",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  arrow: "Arrow",
  text: "Text",
  eraser: "Eraser",
};

const TOOL_PATHS: Record<Tool, string> = {
  select: "m5 3 14 9-7 1-3 7-4-17Z",
  freehand: "M4 18c3-1 4-10 7-10s1 8 4 8 3-3 5-5",
  rectangle: "M4 5h16v14H4z",
  ellipse: "M12 4c5 0 8 3.6 8 8s-3 8-8 8-8-3.6-8-8 3-8 8-8Z",
  arrow: "M4 18 19 5m-7 0h7v7",
  text: "M5 5h14M12 5v14m-4 0h8",
  eraser: "m4 15 9-10 7 7-9 9H7l-3-3a2 2 0 0 1 0-3Z",
};

const subscribers = new Map<string, Set<() => void>>();

function subscribeToBoard(key: string, callback: () => void) {
  let listeners = subscribers.get(key);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(callback);

  const onStorage = (event: StorageEvent) => {
    if (event.key === key) callback();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners?.delete(callback);
    window.removeEventListener("storage", onStorage);
    if (listeners?.size === 0) subscribers.delete(key);
  };
}

function readBoard(key: string): string | null {
  return window.localStorage.getItem(key);
}

function notifyBoardChanged(key: string) {
  subscribers.get(key)?.forEach((callback) => callback());
}

function isPoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && Number.isFinite(point.x) &&
    typeof point.y === "number" && Number.isFinite(point.y);
}

function isSketchElement(value: unknown): value is SketchElement {
  if (!value || typeof value !== "object") return false;
  const element = value as Record<string, unknown>;
  if (typeof element.id !== "string" || typeof element.color !== "string") return false;

  if (element.type === "path") {
    return (
      Array.isArray(element.points) &&
      element.points.every(isPoint) &&
      typeof element.strokeWidth === "number"
    );
  }
  if (element.type === "rectangle" || element.type === "ellipse") {
    return (
      typeof element.x === "number" &&
      typeof element.y === "number" &&
      typeof element.width === "number" &&
      typeof element.height === "number" &&
      typeof element.strokeWidth === "number"
    );
  }
  if (element.type === "arrow") {
    return (
      typeof element.x1 === "number" &&
      typeof element.y1 === "number" &&
      typeof element.x2 === "number" &&
      typeof element.y2 === "number" &&
      typeof element.strokeWidth === "number"
    );
  }
  return (
    element.type === "text" &&
    typeof element.x === "number" &&
    typeof element.y === "number" &&
    typeof element.text === "string"
  );
}

function parseBoard(raw: string | null): SketchElement[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isSketchElement) ? parsed : [];
  } catch {
    return [];
  }
}

function elementId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function moveElement(element: SketchElement, dx: number, dy: number): SketchElement {
  switch (element.type) {
    case "path":
      return { ...element, points: element.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
    case "rectangle":
    case "ellipse":
      return { ...element, x: element.x + dx, y: element.y + dy };
    case "arrow":
      return {
        ...element,
        x1: element.x1 + dx,
        y1: element.y1 + dy,
        x2: element.x2 + dx,
        y2: element.y2 + dy,
      };
    case "text":
      return { ...element, x: element.x + dx, y: element.y + dy };
  }
}

function boundsFromPoints(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function pointFromEvent(event: React.PointerEvent<SVGSVGElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * BOARD_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * BOARD_HEIGHT,
  };
}

export function SketchboardSurface({
  projectId,
  canWrite,
}: {
  projectId: string;
  canWrite: boolean;
}) {
  const storageKey = `${STORAGE_PREFIX}${projectId}`;
  const subscribe = useCallback(
    (callback: () => void) => subscribeToBoard(storageKey, callback),
    [storageKey],
  );
  const getSnapshot = useCallback(() => readBoard(storageKey), [storageKey]);
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const elements = useMemo(() => parseBoard(raw), [raw]);

  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SketchElement | null>(null);
  const [gestureOrigin, setGestureOrigin] = useState<Point | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<SketchElement[] | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [undoStack, setUndoStack] = useState<SketchElement[][]>([]);
  const [redoStack, setRedoStack] = useState<SketchElement[][]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const renderedElements = preview ?? elements;
  const selectedElement = renderedElements.find((element) => element.id === selectedId);

  const persist = useCallback(
    (next: SketchElement[]) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
        notifyBoardChanged(storageKey);
        setSaveError(null);
        return true;
      } catch {
        setSaveError("Could not save this board in browser storage. Free some space and try again.");
        return false;
      }
    },
    [storageKey],
  );

  const commit = useCallback(
    (next: SketchElement[]) => {
      if (!canWrite || !persist(next)) return;
      setUndoStack((stack) => [...stack.slice(-79), elements]);
      setRedoStack([]);
    },
    [canWrite, elements, persist],
  );

  const undo = useCallback(() => {
    if (!canWrite || undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    if (!persist(previous)) return;
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => [...stack, elements]);
    setSelectedId(null);
  }, [canWrite, elements, persist, undoStack]);

  const redo = useCallback(() => {
    if (!canWrite || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    if (!persist(next)) return;
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => [...stack, elements]);
    setSelectedId(null);
  }, [canWrite, elements, persist, redoStack]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraft(null);
        setGestureOrigin(null);
        setDrag(null);
        setPreview(null);
        setTextDraft(null);
        setTool("select");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (
        canWrite &&
        (event.key === "Backspace" || event.key === "Delete") &&
        selectedId &&
        !(event.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(event.target.tagName))
      ) {
        event.preventDefault();
        commit(elements.filter((element) => element.id !== selectedId));
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canWrite, commit, elements, redo, selectedId, undo]);

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    if (!canWrite) return;
    const point = pointFromEvent(event);
    const target = event.target instanceof Element
      ? event.target.closest<SVGElement>("[data-sketch-id]")
      : null;
    const targetId = target?.dataset.sketchId ?? null;

    if (tool === "select") {
      setSelectedId(targetId);
      if (targetId) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setGestureOrigin(point);
        setDrag({ id: targetId, point, original: elements });
      }
      return;
    }

    if (tool === "eraser") {
      if (targetId) commit(elements.filter((element) => element.id !== targetId));
      return;
    }

    if (tool === "text") {
      setTextDraft({ point, value: "" });
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const base = { id: elementId(), color, strokeWidth };
    if (tool === "freehand") {
      setDraft({ ...base, type: "path", points: [point] });
    } else if (tool === "rectangle" || tool === "ellipse") {
      setDraft({
        ...base,
        type: tool,
        x: point.x,
        y: point.y,
        width: 0,
        height: 0,
      });
    } else if (tool === "arrow") {
      setDraft({ ...base, type: "arrow", x1: point.x, y1: point.y, x2: point.x, y2: point.y });
    }
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const point = pointFromEvent(event);
    if (drag) {
      const dx = point.x - drag.point.x;
      const dy = point.y - drag.point.y;
      setPreview(
        drag.original.map((element) =>
          element.id === drag.id ? moveElement(element, dx, dy) : element,
        ),
      );
      return;
    }
    if (!draft) return;
    if (draft.type === "path") {
      setDraft({ ...draft, points: [...draft.points, point] });
    } else if (draft.type === "rectangle" || draft.type === "ellipse") {
      setDraft({
        ...draft,
        ...boundsFromPoints(gestureOrigin ?? { x: draft.x, y: draft.y }, point),
      });
    } else if (draft.type === "arrow") {
      setDraft({ ...draft, x2: point.x, y2: point.y });
    }
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (drag) {
      if (preview) commit(preview);
      setDrag(null);
      setPreview(null);
      return;
    }
    if (draft) {
      const point = pointFromEvent(event);
      let completed = draft;
      if (draft.type === "path" && draft.points.length === 1) {
        completed = { ...draft, points: [...draft.points, point] };
      }
      if (draft.type === "rectangle" || draft.type === "ellipse") {
        completed = {
          ...draft,
          ...boundsFromPoints(gestureOrigin ?? { x: draft.x, y: draft.y }, point),
        };
      }
      if (draft.type === "arrow") completed = { ...draft, x2: point.x, y2: point.y };
      commit([...elements, completed]);
      setSelectedId(null);
      setDraft(null);
      setGestureOrigin(null);
    }
  }

  function finishText() {
    if (textDraft?.value.trim()) {
      const text: SketchElement = {
        id: elementId(),
        type: "text",
        x: textDraft.point.x,
        y: textDraft.point.y,
        text: textDraft.value.trim(),
        color,
      };
      commit([...elements, text]);
      setSelectedId(text.id);
    }
    setTextDraft(null);
    setTool("select");
  }

  const textPosition = textDraft
    ? {
        left: `${(textDraft.point.x / BOARD_WIDTH) * 100}%`,
        top: `${(textDraft.point.y / BOARD_HEIGHT) * 100}%`,
      }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2">
        <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-1">
          {TOOL_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              title={`${TOOL_LABELS[name]}${name === "select" ? " (V)" : ""}`}
              aria-label={TOOL_LABELS[name]}
              aria-pressed={tool === name}
              disabled={!canWrite}
              onClick={() => {
                setTool(name);
                setSelectedId(null);
              }}
              className={`grid size-9 place-items-center rounded-lg transition-colors disabled:opacity-50 ${
                tool === name
                  ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                  : "text-[var(--fg-muted)] hover:bg-[var(--bg-raised)] hover:text-[var(--fg)]"
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="size-5"
              >
                <path d={TOOL_PATHS[name]} />
              </svg>
            </button>
          ))}
        </div>

        <span className="mx-1 hidden h-7 w-px bg-[var(--border)] sm:block" />

        <div className="flex items-center gap-1.5" role="group" aria-label="Stroke color">
          {COLORS.map((choice) => (
            <button
              key={choice}
              type="button"
              aria-label={`Use ${choice} color`}
              aria-pressed={color === choice}
              disabled={!canWrite}
              onClick={() => setColor(choice)}
              className={`size-6 rounded-full border transition-transform hover:scale-110 disabled:opacity-50 ${
                color === choice ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg-raised)]" : "border-white/20"
              }`}
              style={{ backgroundColor: choice }}
            />
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          <span className="sr-only">Stroke width</span>
          <input
            type="range"
            min="1"
            max="8"
            value={strokeWidth}
            disabled={!canWrite}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
            className="w-20 accent-[var(--accent)]"
          />
        </label>

        <div className="ml-auto flex items-center gap-1">
          <ToolbarAction label="Undo" disabled={!canWrite || undoStack.length === 0} onClick={undo}>
            ↶
          </ToolbarAction>
          <ToolbarAction label="Redo" disabled={!canWrite || redoStack.length === 0} onClick={redo}>
            ↷
          </ToolbarAction>
          <span className="mx-1 h-6 w-px bg-[var(--border)]" />
          <ToolbarAction
            label="Clear board"
            disabled={!canWrite || elements.length === 0}
            onClick={() => {
              commit([]);
              setSelectedId(null);
            }}
          >
            Clear
          </ToolbarAction>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-2 text-[11px]">
          <p className="text-[var(--fg-muted)]">
            {canWrite
              ? "Sketch ideas freely, then switch back to Architecture to build the system diagram."
              : "View-only sketchboard."}
          </p>
          <p className={saveError ? "text-[var(--danger)]" : "text-[var(--fg-subtle)]"}>
            {saveError ?? "Saved on this device"}
          </p>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden p-3 pt-0 sm:p-5 sm:pt-0">
          <div className="relative h-full w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-inset)] shadow-[var(--shadow-sm)]">
            <svg
              viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
              preserveAspectRatio="none"
              role="application"
              aria-label="Project sketchboard"
              className={`h-full w-full touch-none ${
                canWrite ? (tool === "select" ? "cursor-default" : "cursor-crosshair") : "cursor-not-allowed"
              }`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <defs>
                <pattern id="sketch-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="var(--border-strong)" opacity="0.55" />
                </pattern>
                <marker
                  id="sketch-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0 0 8 4 0 8" fill="none" stroke="context-stroke" strokeWidth="1.5" />
                </marker>
              </defs>
              <rect width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="var(--bg)" />
              <rect width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="url(#sketch-grid)" />
              {renderedElements.map((element) => (
                <SketchShape
                  key={element.id}
                  element={element}
                  selected={element.id === selectedId}
                />
              ))}
              {draft ? <SketchShape element={draft} selected={false} preview /> : null}
            </svg>

            {textDraft && textPosition ? (
              <input
                autoFocus
                aria-label="Enter text for the sketchboard"
                value={textDraft.value}
                onChange={(event) =>
                  setTextDraft((current) => current && { ...current, value: event.target.value })
                }
                onBlur={finishText}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    finishText();
                  } else if (event.key === "Escape") {
                    setTextDraft(null);
                    setTool("select");
                  }
                }}
                style={{ ...textPosition, color }}
                className="absolute min-w-36 border-b border-[var(--accent)] bg-[var(--bg-raised)]/95 px-1 py-0.5 text-sm outline-none"
                placeholder="Type, then press Enter"
              />
            ) : null}

            {selectedElement && canWrite && tool === "select" ? (
              <span className="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-[var(--border)] bg-[var(--bg-raised)]/90 px-2.5 py-1.5 text-[10px] text-[var(--fg-muted)] shadow-[var(--shadow-sm)]">
                Drag to move · Delete to remove
              </span>
            ) : null}

            {elements.length === 0 && !draft && !textDraft ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center">
                <div className="max-w-sm px-6 text-center">
                  <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)] text-[var(--accent)]">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-6">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4 17 5-5 3 3 5-7 3 3M4 20h16" />
                    </svg>
                  </div>
                  <p className="mt-4 text-sm font-medium">A blank space for your next idea</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--fg-muted)]">
                    Choose a tool above and draw a flow, jot down notes, or map out an early concept.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--fg-muted)] hover:bg-[var(--bg)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function SketchShape({
  element,
  selected,
  preview = false,
}: {
  element: SketchElement;
  selected: boolean;
  preview?: boolean;
}) {
  const common = {
    stroke: element.color,
    strokeWidth: "strokeWidth" in element ? element.strokeWidth : 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
    opacity: preview ? 0.72 : 1,
  };

  return (
    <g
      data-sketch-id={element.id}
      className={selected ? "drop-shadow-[0_0_5px_var(--accent)]" : undefined}
    >
      {element.type === "path" ? (
        <polyline
          {...common}
          points={element.points.map((point) => `${point.x},${point.y}`).join(" ")}
        />
      ) : null}
      {element.type === "rectangle" ? (
        <rect
          {...common}
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
        />
      ) : null}
      {element.type === "ellipse" ? (
        <ellipse
          {...common}
          cx={element.x + element.width / 2}
          cy={element.y + element.height / 2}
          rx={element.width / 2}
          ry={element.height / 2}
        />
      ) : null}
      {element.type === "arrow" ? (
        <line
          {...common}
          x1={element.x1}
          y1={element.y1}
          x2={element.x2}
          y2={element.y2}
          markerEnd="url(#sketch-arrow)"
        />
      ) : null}
      {element.type === "text" ? (
        <text
          x={element.x}
          y={element.y}
          fill={element.color}
          fontSize="28"
          fontFamily="var(--font-sans), sans-serif"
        >
          {element.text}
        </text>
      ) : null}
    </g>
  );
}
