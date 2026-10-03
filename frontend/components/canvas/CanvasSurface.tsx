"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ComponentNode } from "@/components/canvas/ComponentNode";
import { NodePalette } from "@/components/canvas/NodePalette";
import { ComponentPropertiesPanel } from "@/components/canvas/ComponentPropertiesPanel";
import { AutoSaveIndicator } from "@/components/canvas/AutoSaveIndicator";
import { SnapshotHistory } from "@/components/canvas/SnapshotHistory";
import { Cursors } from "@/components/canvas/Cursors";
import { useCanvas } from "@/components/canvas/CanvasDocumentProvider";
import {
  EMPTY_CANVAS,
  NODE_META,
  NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type NodeType,
} from "@/lib/canvas";
import { newId } from "@/hooks/useCanvasDocument";
import { useAutosave } from "@/hooks/useAutosave";
import type { Snapshot } from "@/lib/types";

const SNAPSHOT_GRID = 20;

/**
 * The diagram canvas.
 *
 * Consumes the canvas document from context and only handles rendering and
 * gestures. The transport (Liveblocks or local) is decided above it.
 */

function CanvasInner({ projectId, snapshots }: { projectId: string; snapshots: Snapshot[] }) {
  const doc = useCanvas();
  const { screenToFlowPosition } = useReactFlow();
  const [pendingKind, setPendingKind] = useState<NodeType | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { nodes, edges } = doc;
  const canvasState = useMemo(() => ({ nodes, edges }), [nodes, edges]);
  const autosave = useAutosave({
    projectId,
    state: canvasState,
    canWrite: doc.canWrite,
  });

  const flowNodes = useMemo<Node[]>(
    () =>
      doc.nodes.map((node) => ({
        id: node.id,
        type: "component",
        position: node.position,
        data: {
          kind: node.type,
          label: node.data.label,
          tech: node.data.tech,
          description: node.data.description,
          attributes: node.data.attributes,
          readOnly: !doc.canWrite,
          onLabelChange: (id: string, label: string) => {
            const existing = doc.nodes.find((n) => n.id === id);
            if (!existing) return;
            doc.upsertNode({ ...existing, data: { ...existing.data, label } });
          },
        },
      })),
    [doc],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      doc.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        style: { stroke: "var(--fg-muted)", strokeWidth: 2.5 },
        labelStyle: { fontSize: 11, fill: "var(--fg-muted)" },
        labelBgStyle: { fill: "var(--bg)" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "var(--accent)",
          width: 14,
          height: 14,
          markerUnits: "userSpaceOnUse",
        },
      })),
    [doc.edges],
  );

  const nodeTypes = useMemo<NodeTypes>(() => ({ component: ComponentNode }), []);
  const selectedNode = doc.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams<Node, Edge>) => {
      setSelectedNodeId(selected[0]?.id ?? null);
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!doc.canWrite) return;
      for (const change of changes) {
        if (change.type === "remove") {
          doc.removeNode(change.id);
        } else if (change.type === "position" && change.position) {
          const existing = doc.nodes.find((n) => n.id === change.id);
          if (!existing) continue;
          doc.upsertNode({ ...existing, position: change.position });
        }
      }
    },
    [doc],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!doc.canWrite) return;
      for (const change of changes) {
        if (change.type === "remove") doc.removeEdge(change.id);
      }
    },
    [doc],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!doc.canWrite || !connection.source || !connection.target) return;
      const edge: CanvasEdge = {
        id: newId("edge"),
        source: connection.source,
        target: connection.target,
      };
      doc.upsertEdge(edge);
    },
    [doc],
  );

  const place = useCallback(
    (kind: NodeType, clientX: number, clientY: number) => {
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      const node: CanvasNode = {
        id: newId(kind),
        type: kind,
        position: {
          x: Math.round(position.x / SNAPSHOT_GRID) * SNAPSHOT_GRID,
          y: Math.round(position.y / SNAPSHOT_GRID) * SNAPSHOT_GRID,
        },
        data: { label: NODE_META[kind].label },
      };
      doc.upsertNode(node);
    },
    [doc, screenToFlowPosition],
  );

  // Click-to-place, for trackpads and keyboard users.
  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!pendingKind || !doc.canWrite) return;
      place(pendingKind, event.clientX, event.clientY);
      setPendingKind(null);
    },
    [doc, pendingKind, place],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      if (!doc.canWrite) return;
      const kind = event.dataTransfer.getData("application/ghost-node") as NodeType;
      if (!NODE_TYPES.includes(kind)) return;
      place(kind, event.clientX, event.clientY);
    },
    [doc.canWrite, place],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        onConnect={onConnect}
        onPaneClick={onPaneClick}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodesDraggable={doc.canWrite}
        nodesConnectable={doc.canWrite}
        deleteKeyCode={doc.canWrite ? ["Backspace", "Delete"] : null}
        connectionLineType={ConnectionLineType.SmoothStep}
        defaultEdgeOptions={{ type: "smoothstep" }}
        fitView
        proOptions={{ hideAttribution: true }}
        className="bg-[var(--bg)]"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      {/* Peer cursors sit above the flow but must not block pointer events. */}
      <div className="pointer-events-none absolute inset-0">
        <Cursors
          peers={doc.peers}
          onLocalMove={doc.setCursor}
          nodes={flowNodes}
          edges={flowEdges}
        />
      </div>

      <AutoSaveIndicator
        saveState={autosave.saveState}
        lastSavedAt={autosave.lastSavedAt}
        error={autosave.error}
        onRetry={autosave.saveNow}
      />

      <div className="absolute bottom-5 left-5 z-10 w-72">
        <SnapshotHistory
          projectId={projectId}
          snapshots={snapshots}
          canRestore={doc.canWrite}
          onErase={async () => {
            doc.replaceAll(EMPTY_CANVAS);
            await autosave.saveNow(EMPTY_CANVAS);
          }}
          onRestore={(restored) => {
            doc.replaceAll(restored);
            void autosave.saveNow();
          }}
        />
      </div>

      <NodePalette
        disabled={!doc.canWrite}
        pendingKind={pendingKind}
        onPickKind={setPendingKind}
        onDragStart={(event, kind) => {
          event.dataTransfer.setData("application/ghost-node", kind);
          event.dataTransfer.effectAllowed = "copy";
        }}
      />

      {selectedNode ? (
        <div className="absolute bottom-5 left-1/2 z-10 w-[min(24rem,calc(100%-2rem))] -translate-x-1/2">
          <ComponentPropertiesPanel
            node={selectedNode}
            canWrite={doc.canWrite}
            onClose={() => setSelectedNodeId(null)}
            onChange={(data) => doc.upsertNode({ ...selectedNode, data })}
          />
        </div>
      ) : null}

      {pendingKind ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
          <span className="rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">
            Click the canvas to place a {NODE_META[pendingKind].label.toLowerCase()} · Esc to cancel
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The diagram canvas surface.
 *
 * Consumes the document from context so the surrounding workspace can also read
 * it: the AI panel writes a generated diagram into the same shared state.
 */
export function CanvasSurface({
  projectId,
  snapshots,
}: {
  projectId: string;
  snapshots: Snapshot[];
}) {
  return <CanvasInner projectId={projectId} snapshots={snapshots} />;
}
