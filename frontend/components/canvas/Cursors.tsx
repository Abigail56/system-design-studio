"use client";

import { useEffect } from "react";
import { useReactFlow, type Node, type Edge } from "@xyflow/react";

import type { Peer } from "@/hooks/useCanvasDocument";

/**
 * Other people's cursors.
 *
 * Cursors are tracked in flow (canvas) coordinates, not screen coordinates, so
 * they stay on the right shape when a collaborator is zoomed or panned
 * differently. React Flow transforms that overlay for us.
 */
export function Cursors({
  peers,
  onLocalMove,
  nodes,
  edges,
}: {
  peers: Peer[];
  onLocalMove: (point: { x: number; y: number } | null) => void;
  nodes: Node[];
  edges: Edge[];
}) {
  const { screenToFlowPosition } = useReactFlow();

  // Throttle: presence updates are a network message, and mousemove fires far
  // more often than the socket can usefully carry.
  useEffect(() => {
    let lastSent = 0;
    let pending: { x: number; y: number } | null = null;
    let frame = 0;

    const send = () => {
      frame = 0;
      const now = Date.now();
      if (now - lastSent < 60) return; // ~16 msgs/sec ceiling
      lastSent = now;
      onLocalMove(pending);
      pending = null;
    };

    const onPointerMove = (event: PointerEvent) => {
      pending = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!frame) frame = window.setTimeout(send, 60);
    };

    const onPointerLeave = () => onLocalMove(null);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerleave", onPointerLeave);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      if (frame) window.clearTimeout(frame);
      onLocalMove(null);
    };
    // `nodes`/`edges` are accepted so this effect re-registers when the document
    // changes shape and `screenToFlowPosition` identity moves with it.
  }, [screenToFlowPosition, onLocalMove, nodes, edges]);

  return (
    <>
      {peers.map((peer) =>
        peer.cursor ? (
          <div
            key={String(peer.id)}
            className="pointer-events-none absolute z-20"
            style={{
              transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)`,
            }}
          >
            <svg width="14" height="18" viewBox="0 0 14 18" aria-hidden>
              <path
                d="M1 1l11 7-5 .8L4.5 16 1 1z"
                fill={peer.color}
                stroke="white"
                strokeWidth="1"
              />
            </svg>
            <span
              className="ml-2 -mt-1 block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: peer.color }}
            >
              {peer.name}
              {peer.role && peer.role !== "OWNER" ? ` · ${peer.role.toLowerCase()}` : ""}
            </span>
          </div>
        ) : null,
      )}
    </>
  );
}