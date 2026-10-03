/**
 * Canvas domain types, shared by the canvas, the AI tasks and the snapshot
 * payload.
 *
 * These mirror the structured-output schema the AI is asked to produce, so a
 * generated diagram and a hand-built one are the same shape.
 */

export const NODE_TYPES = ["service", "database", "queue", "client", "entity"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export type Point = { x: number; y: number };

export type EntityAttribute = {
  name: string;
  type: string;
  key: "PK" | "FK" | "PK, FK" | "";
};

export type CanvasNodeData = {
  label: string;
  /** Short technology hint, e.g. "Postgres" or "Node.js". */
  tech?: string;
  description?: string;
  attributes?: EntityAttribute[];
};

export type CanvasNode = {
  id: string;
  type: NodeType;
  position: Point;
  data: CanvasNodeData;
};

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  /** Short verb describing the interaction, e.g. "reads", "publishes". */
  label?: string;
};

/** The whole document. This is what gets saved, generated, and diffed. */
export type CanvasState = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

export const EMPTY_CANVAS: CanvasState = { nodes: [], edges: [] };

/** Node kind to colour and label, used by the palette and the nodes themselves. */
export const NODE_META: Record<
  NodeType,
  { label: string; accent: string; dot: string; description: string }
> = {
  service: {
    label: "Service",
    accent: "border-[var(--node-service)]/45 bg-[var(--node-service)]/8",
    dot: "bg-[var(--node-service)]",
    description: "Compute or API endpoint",
  },
  database: {
    label: "Database",
    accent: "border-[var(--node-database)]/45 bg-[var(--node-database)]/8",
    dot: "bg-[var(--node-database)]",
    description: "Persistent storage",
  },
  queue: {
    label: "Queue",
    accent: "border-[var(--node-queue)]/45 bg-[var(--node-queue)]/8",
    dot: "bg-[var(--node-queue)]",
    description: "Async buffer or stream",
  },
  client: {
    label: "Client",
    accent: "border-[var(--node-client)]/45 bg-[var(--node-client)]/8",
    dot: "bg-[var(--node-client)]",
    description: "User-facing surface",
  },
  entity: {
    label: "Entity",
    accent: "border-[var(--node-database)]/45 bg-[var(--node-database)]/8",
    dot: "bg-[var(--node-database)]",
    description: "ERD table with typed fields",
  },
};

export function isCanvasState(value: unknown): value is CanvasState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanvasState>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}

/** Defensive parse. Returns null rather than throwing on malformed input. */
export function parseCanvasState(raw: string | null | undefined): CanvasState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCanvasState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Ids must be unique across the document; AI output is validated against this. */
export function hasDuplicateIds(state: CanvasState): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of [...state.nodes, ...state.edges]) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

/** Edges pointing at nodes that do not exist would render as broken lines. */
export function danglingEdgeIds(state: CanvasState): string[] {
  const nodeIds = new Set(state.nodes.map((node) => node.id));
  return state.edges
    .filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
    .map((edge) => edge.id);
}