"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { RoomProvider, ClientSideSuspense } from "@liveblocks/react/suspense";
import { LiveMap } from "@liveblocks/core";
import type { CanvasEdge, CanvasNode } from "@/lib/canvas";
import { ReactFlowProvider } from "@xyflow/react";

import { liveblocksClient, roomIdFor } from "@/lib/liveblocks";
import { useCanvasDocument, type CanvasDocument } from "@/hooks/useCanvasDocument";
import { useLiveCanvas } from "@/hooks/useLiveCanvas";

/**
 * Supplies the canvas document, choosing the transport.
 *
 * Context rather than a callback prop: the Liveblocks hook lives under
 * `RoomProvider`, which is itself a context boundary, so the consumer cannot be
 * the component that decides whether to render it. Passing the document up
 * through a callback would mean calling a parent setter during render, which
 * React does not allow cleanly.
 *
 * Two transports, one interface:
 *   - Liveblocks when a public key is configured (real-time, presence)
 *   - local storage otherwise (single user)
 *
 * The board above cannot tell which it has, so adding a key is not a UI change.
 */

const CanvasDocumentContext = createContext<CanvasDocument | null>(null);

function useCanvasDocumentOrThrow(): CanvasDocument {
  const value = useContext(CanvasDocumentContext);
  if (!value) {
    throw new Error(
      "useCanvasDocumentContext used outside a CanvasDocumentProvider",
    );
  }
  return value;
}

export { useCanvasDocumentOrThrow as useCanvas };

export function CanvasDocumentProvider({
  projectId,
  canWrite,
  initial,
  children,
}: {
  projectId: string;
  canWrite: boolean;
  /** Server-supplied state, e.g. the newest snapshot. Wins over local storage. */
  initial?: CanvasStateInit;
  children: ReactNode;
}) {
  if (liveblocksClient) {
    return (
      <LiveProvider projectId={projectId} canWrite={canWrite}>
        {children}
      </LiveProvider>
    );
  }

  return (
    <LocalProvider projectId={projectId} canWrite={canWrite} initial={initial}>
      {children}
    </LocalProvider>
  );
}

function LocalProvider({
  projectId,
  canWrite,
  initial,
  children,
}: {
  projectId: string;
  canWrite: boolean;
  initial?: CanvasStateInit;
  children: ReactNode;
}) {
  const doc = useCanvasDocument({ projectId, canWrite, initial });
  return (
    <CanvasDocumentContext.Provider value={doc}>
      {children}
    </CanvasDocumentContext.Provider>
  );
}

function LiveProvider({
  projectId,
  canWrite,
  children,
}: {
  projectId: string;
  canWrite: boolean;
  children: ReactNode;
}) {
  return (
    <RoomProvider
      id={roomIdFor(projectId)}
      initialPresence={{ cursor: null, selection: [] }}
      // LiveMap, not Map: initialStorage is typed as live primitives.
      initialStorage={{ nodes: new LiveMap<string, CanvasNode>(), edges: new LiveMap<string, CanvasEdge>() }}
    >
      <ClientSideSuspense
        fallback={
          <div className="grid h-full place-items-center text-xs text-[var(--fg-muted)]">
            Connecting to the room…
          </div>
        }
      >
        <LiveInner projectId={projectId} canWrite={canWrite}>
          {children}
        </LiveInner>
      </ClientSideSuspense>
    </RoomProvider>
  );
}

function LiveInner({
  projectId,
  canWrite,
  children,
}: {
  projectId: string;
  canWrite: boolean;
  children: ReactNode;
}) {
  const doc = useLiveCanvas({ projectId, canWrite });
  // `useLiveCanvas` returns a fresh object each render, so memoise before
  // putting it in context or every consumer re-renders on every store update.
  const value = useMemo(() => doc, [doc]);
  return (
    <CanvasDocumentContext.Provider value={value}>{children}</CanvasDocumentContext.Provider>
  );
}

export function CanvasDocumentBoundary({ children }: { children: ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

type CanvasStateInit = Parameters<typeof useCanvasDocument>[0]["initial"];