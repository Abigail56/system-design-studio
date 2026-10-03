"use client";

import { useCallback, useMemo } from "react";
import {
  useMutation,
  useMyPresence,
  useOthers,
  useStatus,
  useStorage,
} from "@liveblocks/react/suspense";

import type { CanvasEdge, CanvasNode, CanvasState } from "@/lib/canvas";
import { colorFor } from "@/lib/liveblocks";
import type { CanvasDocument, Peer, SyncStatus } from "@/hooks/useCanvasDocument";

/**
 * Liveblocks-backed canvas document.
 *
 * Mirrors `useCanvasDocument`'s interface so the board above cannot tell which
 * transport it has. Storage is a pair of LiveMaps keyed by id rather than
 * arrays: dragging one node writes one key, so two people moving different
 * shapes do not overwrite each other. That is the whole reason for not storing
 * the document as a single blob.
 *
 * Note `useMutation` returns the callback with its first argument (the context)
 * already bound, so there is no `{ mutate }` to destructure.
 */

type MyPresence = {
  cursor: { x: number; y: number } | null;
  selection: string[];
};

type OtherPresence = { cursor: { x: number; y: number } | null };
type OtherInfo = { name?: string; avatar?: string; role?: string };

export function useLiveCanvas(options: {
  projectId: string;
  canWrite: boolean;
}): CanvasDocument {
  const { canWrite } = options;

  // The room schema is declared in CanvasDocumentProvider's initialStorage; the
  // selectors here just narrow to the two maps.
  const nodesMap = useStorage((root) => root.nodes);
  const edgesMap = useStorage((root) => root.edges);

  const connectionStatus = useStatus();
  const [, updateMyPresence] = useMyPresence();
  const others = useOthers((list) => list);

  const nodes = useMemo<CanvasNode[]>(
    () => (nodesMap ? Array.from((nodesMap as unknown as StorageMap<CanvasNode>).values()) : []),
    [nodesMap],
  );
  const edges = useMemo<CanvasEdge[]>(
    () => (edgesMap ? Array.from((edgesMap as unknown as StorageMap<CanvasEdge>).values()) : []),
    [edgesMap],
  );

  // Each mutation is separate because the callback's remaining arguments define
  // its payload type. `canWrite` is in the deps so flipping the role re-creates
  // them, which is what stops a newly-demoted VIEWER from writing.
  const writeNode = useMutation(
    ({ storage }: MutationContext, node: CanvasNode) => {
      (storage.get("nodes") as unknown as StorageMap<CanvasNode>).set(node.id, node);
    },
    [canWrite],
  );

  const dropNode = useMutation(({ storage }: MutationContext, id: string) => {
    const nodesStore = storage.get("nodes") as unknown as StorageMap<CanvasNode>;
    const edgesStore = storage.get("edges") as unknown as StorageMap<CanvasEdge>;
    nodesStore.delete(id);
    // Edges touching a removed node go too, or they render as lines running off
    // into nothing for everyone.
    for (const edge of edgesStore.values()) {
      if (edge.source === id || edge.target === id) edgesStore.delete(edge.id);
    }
  }, [canWrite]);

  const writeEdge = useMutation(
    ({ storage }: MutationContext, edge: CanvasEdge) => {
      (storage.get("edges") as unknown as StorageMap<CanvasEdge>).set(edge.id, edge);
    },
    [canWrite],
  );

  const dropEdge = useMutation(({ storage }: MutationContext, id: string) => {
    (storage.get("edges") as unknown as StorageMap<CanvasEdge>).delete(id);
  }, [canWrite]);

  const clearAll = useMutation(({ storage }: MutationContext, next: CanvasState) => {
    const nodesStore = storage.get("nodes") as unknown as StorageMap<CanvasNode>;
    const edgesStore = storage.get("edges") as unknown as StorageMap<CanvasEdge>;
    for (const id of Array.from(nodesStore.keys())) nodesStore.delete(id);
    for (const id of Array.from(edgesStore.keys())) edgesStore.delete(id);
    for (const node of next.nodes) nodesStore.set(node.id, node);
    for (const edge of next.edges) edgesStore.set(edge.id, edge);
  }, [canWrite]);

  const upsertNode = useCallback(
    (node: CanvasNode) => {
      if (!canWrite) return;
      writeNode(node);
    },
    [canWrite, writeNode],
  );

  const removeNode = useCallback(
    (id: string) => {
      if (!canWrite) return;
      dropNode(id);
    },
    [canWrite, dropNode],
  );

  const upsertEdge = useCallback(
    (edge: CanvasEdge) => {
      if (!canWrite) return;
      writeEdge(edge);
    },
    [canWrite, writeEdge],
  );

  const removeEdge = useCallback(
    (id: string) => {
      if (!canWrite) return;
      dropEdge(id);
    },
    [canWrite, dropEdge],
  );

  const replaceAll = useCallback(
    (next: CanvasState) => {
      if (!canWrite) return;
      clearAll(next);
    },
    [canWrite, clearAll],
  );

  const setCursor = useCallback(
    (point: { x: number; y: number } | null) => {
      updateMyPresence({ cursor: point, selection: [] } satisfies MyPresence);
    },
    [updateMyPresence],
  );

  const status: SyncStatus =
    connectionStatus === "connected"
      ? "connected"
      : connectionStatus === "connecting" || connectionStatus === "initial"
        ? "connecting"
        : "offline";

  const peers = useMemo<Peer[]>(
    () =>
      others.map((other) => ({
        id: other.connectionId,
        name: other.info?.name ?? "Collaborator",
        color: colorFor(other.connectionId),
        cursor: (other.presence as OtherPresence | null)?.cursor ?? null,
        role: (other.info as OtherInfo | null)?.role,
      })),
    [others],
  );

  return useMemo(
    () => ({
      nodes,
      edges,
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
      nodes,
      edges,
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

/**
 * Local aliases so the casts above read as intent rather than noise. The room
 * schema is declared once, in `CanvasDocumentProvider`; these keep that
 * declaration from leaking through every mutation callback.
 */
type StorageMap<T> = {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<T>;
};

type MutationContext = { storage: { get(key: string): unknown } };