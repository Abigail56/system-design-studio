import { notFound, redirect } from "next/navigation";
import AppShell from "@/components/layout/AppShell";
import { CanvasWorkspace } from "@/components/canvas/CanvasWorkspace";
import type { WorkspaceView } from "@/components/canvas/CanvasWorkspace";
import { apiPaths, ApiError } from "@/lib/api-client";
import { apiFetch } from "@/lib/api-server";
import { parseCanvasState, type CanvasState } from "@/lib/canvas";
import type { ProjectDetail, ProjectInvite, Snapshot, UserBrief } from "@/lib/types";

/**
 * Project workspace.
 *
 * All data is fetched here, on the server, and handed to the client workspace:
 * the canvas needs the shared document in order to accept a generated diagram,
 * and fetching in the client would duplicate what this render already knows.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { projectId } = await params;
  const { view: requestedView } = await searchParams;
  const view: WorkspaceView = requestedView === "sketch" ? "sketch" : "diagram";

  let project: ProjectDetail;
  let viewer: UserBrief;
  let snapshots: Snapshot[];
  let invites: ProjectInvite[] = [];
  let initialState: CanvasState | undefined;

  try {
    viewer = (await apiFetch<{ user: UserBrief }>(apiPaths.me)).user;
    project = (await apiFetch<{ project: ProjectDetail }>(apiPaths.project(projectId))).project;

    if (view === "diagram") {
      const snapshotResponse = await apiFetch<{ snapshots: Snapshot[] }>(
        apiPaths.snapshots(projectId),
      );
      snapshots = snapshotResponse.snapshots;

      // Open onto the most recent saved design. Without this a fresh browser
      // starts blank even though the project has history, because the document
      // hook's other source is this machine's local storage.
      const newest = snapshots[0];
      if (newest) {
        try {
          const content = await apiFetch<{ state: string }>(
            apiPaths.snapshotContent(projectId, newest.id),
          );
          initialState = parseCanvasState(content.state) ?? undefined;
        } catch {
          // A snapshot that cannot be read should not block the workspace.
        }
      }
    } else {
      snapshots = [];
    }

    if (project.role === "OWNER") {
      invites = (
        await apiFetch<{ invites: ProjectInvite[] }>(apiPaths.invites(projectId))
      ).invites;
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    // The session can expire between Clerk's check in `proxy.ts` and this fetch.
    // Send the visitor back to sign-in rather than rendering an error page for
    // what is really an auth problem.
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    throw error;
  }

  return (
    <AppShell fullHeight workspace>
      <CanvasWorkspace
        projectId={projectId}
        project={project}
        view={view}
        snapshots={snapshots}
        invites={invites}
        viewerId={viewer.id}
        initialState={initialState}
      />
    </AppShell>
  );
}