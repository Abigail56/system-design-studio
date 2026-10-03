"use client";

import {
  CanvasDocumentBoundary,
  CanvasDocumentProvider,
} from "@/components/canvas/CanvasDocumentProvider";
import { AiPanel } from "@/components/ai/AiPanel";
import { CanvasSurface } from "@/components/canvas/CanvasSurface";
import { MemberList } from "@/components/projects/MemberList";
import { InviteMemberForm } from "@/components/projects/InviteMemberForm";
import { InviteList } from "@/components/projects/InviteList";
import type { CanvasState } from "@/lib/canvas";
import type { ProjectDetail, ProjectInvite, Snapshot } from "@/lib/types";

/**
 * The project workspace: canvas on the left, AI and people on the right.
 *
 * A client component because the AI panel needs the canvas document in order to
 * write a generated diagram into shared state. The server hands it everything
 * it already fetched, so this adds no extra round trip.
 */
export function CanvasWorkspace({
  projectId,
  project,
  snapshots,
  invites,
  viewerId,
  initialState,
}: {
  projectId: string;
  project: ProjectDetail;
  snapshots: Snapshot[];
  invites: ProjectInvite[];
  /** The signed-in user, so their own row can be marked "(you)". */
  viewerId: string;
  /** Newest snapshot, so a fresh browser opens onto the saved design rather
   *  than an empty canvas. Wins over local storage, being the newer copy. */
  initialState?: CanvasState;
}) {
  const canWrite = project.role === "OWNER" || project.role === "EDITOR";

  return (
    <CanvasDocumentBoundary key={projectId}>
      <CanvasDocumentProvider projectId={projectId} canWrite={canWrite} initial={initialState}>
        <div className="flex h-full min-h-0">
          <div className="min-w-0 flex-1">
            <div className="flex h-16 items-center justify-between gap-4 border-b border-[var(--border)] bg-[var(--bg-raised)] px-5">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--fg-subtle)]">
                  Your canvas
                </p>
                <h1 className="mt-0.5 truncate font-[family-name:var(--font-display)] text-base font-semibold tracking-tight">
                  {project.name}
                </h1>
              </div>
              <span className="hidden shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[11px] font-medium text-[var(--fg-muted)] shadow-[var(--shadow-sm)] sm:inline-flex">
                <span
                  aria-hidden
                  className={`size-2 rounded-full ${canWrite ? "bg-[var(--success)]" : "bg-[var(--accent)]"}`}
                />
                {canWrite ? "Collaborative canvas" : "View-only access"}
              </span>
            </div>
            <div className="h-[calc(100%-4rem)]">
              <CanvasSurface projectId={projectId} snapshots={snapshots} />
            </div>
          </div>

          <AiPanel projectId={projectId}>
            <CollaboratorsSection
              projectId={projectId}
              project={project}
              invites={invites}
              canWrite={canWrite}
              viewerId={viewerId}
            />
          </AiPanel>
        </div>
      </CanvasDocumentProvider>
    </CanvasDocumentBoundary>
  );
}

/** The People tab. Rendered inside the AI panel's container, so it stays a
 *  server-fetched, no-client-fetch surface. */
function CollaboratorsSection({
  projectId,
  project,
  invites,
  canWrite,
  viewerId,
}: {
  projectId: string;
  project: ProjectDetail;
  invites: ProjectInvite[];
  canWrite: boolean;
  viewerId: string;
}) {
  return (
    <div className="space-y-5">
      {canWrite ? (
        <div>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
            Add someone
          </h2>
          <InviteMemberForm projectId={projectId} />
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-subtle)]">
          Collaborators
        </h2>
        <MemberList
          projectId={projectId}
          viewerId={viewerId}
          viewerRole={project.role}
          ownerId={project.owner_id}
          members={project.members}
        />
      </div>

      <InviteList projectId={projectId} invites={invites} />

      {!canWrite ? (
        <p className="rounded-md bg-[var(--bg-inset)] px-3 py-2 text-xs text-[var(--fg-muted)]">
          You have view-only access to this canvas.
        </p>
      ) : null}
    </div>
  );
}
