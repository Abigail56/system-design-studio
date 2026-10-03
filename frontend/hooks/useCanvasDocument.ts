"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  EMPTY_CANVAS,
  parseCanvasState,
  type CanvasEdge,
  type CanvasNode,
  type CanvasState,
} from "@/lib/canvas";

/**
 * The canvas document: nodes, edges, and the operations that change them.
 *
 * One interface, two transports. With Liveblocks configured the document is a
 * shared LiveMap so several people edit it at once; without a key it is local
 * state persisted to localStorage. The canvas component above cannot tell the
 * difference, which is the point: adding a key later must not require touching
 * the UI.
 *
 * Why not Yjs, as the original spec proposed: Liveblocks ships its own storage
 * primitives and presence, and mixing a second CRDT alongside them means two
 * sources of truth for the same document.
 */

export type SyncStatus = "local" | "connecting" | "connected" | "offline";

export type Peer = {
  id: number | string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  role?: string;
};

export type CanvasDocument = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** VIEWERs get a document they can see but every mutation is a no-op. */
  canWrite: boolean;
  status: SyncStatus;
  peers: Peer[];

  upsertNode: (node: CanvasNode) => void;
  removeNode: (id: string) => void;
  upsertEdge: (edge: CanvasEdge) => void;
  removeEdge: (id: string) => void;
  /** Used by AI generation to lay down a whole diagram. */
  replaceAll: (state: CanvasState) => void;
  setCursor: (point: { x: number; y: number } | null) => void;
};

const STORAGE_PREFIX = "ghost:canvas:";

/** Stable id without pulling in a uuid dependency. */
function newId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

function readLocal(projectId: string): CanvasState {
  if (typeof window === "undefined") return EMPTY_CANVAS;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
    return parseCanvasState(raw) ?? EMPTY_CANVAS;
  } catch {
    // Private mode or a full quota: start empty rather than break the canvas.
    return EMPTY_CANVAS;
  }
}

export function useCanvasDocument(options: {
  projectId: string;
  canWrite: boolean;
  initial?: CanvasState;
}): CanvasDocument {
  const { projectId, canWrite, initial } = options;

  // Lazily initialised rather than loaded in an effect: reading local storage
  // during render is cheap and synchronous, whereas setting state inside an
  // effect costs an extra render pass and trips
  // `react-hooks/set-state-in-effect`.
  //
  // Safe only because the board is keyed on projectId, so moving between
  // projects remounts instead of re-deriving.
  const [state, setState] = useState<CanvasState>(
    () => initial ?? readLocal(projectId),
  );
  // Single-user for now: the document lives in local storage. The Liveblocks
  // transport will supply a real status and peer list once a key is configured,
  // so there are deliberately no setters here rather than dead ones. The empty
  // array is memoised because it feeds the useMemo further down.
  const status: SyncStatus = "local";
  const peers: Peer[] = useMemo(() => [], []);

  // Persist on change. This effect is legitimate: localStorage is an external
  // system, so writing to it from an effect is the intended use.
  useEffect(() => {
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(state));
    } catch {
      // Losing local persistence is not worth breaking the editor over.
    }
  }, [state, projectId]);

  const upsertNode = useCallback(
    (node: CanvasNode) => {
      if (!canWrite) return;
      setState((current) => {
        const index = current.nodes.findIndex((n) => n.id === node.id);
        if (index === -1) return { ...current, nodes: [...current.nodes, node] };
        const nodes = current.nodes.slice();
        nodes[index] = node;
        return { ...current, nodes };
      });
    },
    [canWrite],
  );

  const removeNode = useCallback(
    (id: string) => {
      if (!canWrite) return;
      setState((current) => ({
        // Edges touching a deleted node have to go with it, or they render as
        // lines running off into nothing.
        nodes: current.nodes.filter((n) => n.id !== id),
        edges: current.edges.filter((e) => e.source !== id && e.target !== id),
      }));
    },
    [canWrite],
  );

  const upsertEdge = useCallback(
    (edge: CanvasEdge) => {
      if (!canWrite) return;
      setState((current) => {
        const exists = current.edges.some((e) => e.id === edge.id);
        return {
          ...current,
          edges: exists
            ? current.edges.map((e) => (e.id === edge.id ? edge : e))
            : [...current.edges, edge],
        };
      });
    },
    [canWrite],
  );

  const removeEdge = useCallback(
    (id: string) => {
      if (!canWrite) return;
      setState((current) => ({ ...current, edges: current.edges.filter((e) => e.id !== id) }));
    },
    [canWrite],
  );

  const replaceAll = useCallback(
    (next: CanvasState) => {
      if (!canWrite) return;
      setState({ nodes: next.nodes, edges: next.edges });
    },
    [canWrite],
  );

  const setCursor = useCallback((point: { x: number; y: number } | null) => {
    // Single-user transport has no peers to broadcast to. When Liveblocks is
    // wired in, this writes to presence instead.
    void point;
  }, []);

  return useMemo(
    () => ({
      nodes: state.nodes,
      edges: state.edges,
      canWrite,
      status,
      peers,
      upsertNode,
      removeNode,
      upsertEdge,
      removeEdge,
      replaceAll,
      setCursor,
    }),
    [
      state,
      canWrite,
      status,
      peers,
      upsertNode,
      removeNode,
      upsertEdge,
      removeEdge,
      replaceAll,
      setCursor,
    ],
  );
}

export { newId };