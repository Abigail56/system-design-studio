import { Liveblocks } from "@liveblocks/node";
// `Permission` is declared in @liveblocks/core and not re-exported from node.
import { Permission } from "@liveblocks/core";
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { apiPaths } from "@/lib/api-client";
import { apiFetch } from "@/lib/api-server";

/**
 * Mints a Liveblocks access token scoped to one project room.
 *
 * Why this route lives in Next.js rather than the FastAPI service: Liveblocks
 * tokens are minted by `@liveblocks/node`, and hand-rolling that token format
 * is exactly the kind of thing that breaks silently when Liveblocks changes it.
 * The SDK is a Node package, so it belongs here.
 *
 * This does not weaken the "only api/ touches the database" rule. Membership is
 * decided by `api/`, which this route calls with the caller's Clerk session; a
 * user removed from a project loses room access on the next token refresh.
 */

const ROOM_PREFIX = "project:";

/**
 * VIEWERs must be able to follow a live canvas without changing it. Note that
 * `room:read` alone is not enough: the canvas document lives in Liveblocks
 * *storage*, which is a separate permission. Without `storage:read` a viewer
 * connects fine and then renders an empty canvas.
 *
 * Presence write is granted to both roles so cursors work for viewers too.
 */
const VIEWER_PERMISSIONS = [
  Permission.RoomRead,
  Permission.StorageRead,
  Permission.LegacyRoomPresenceWrite,
  Permission.CommentsRead,
];

const EDITOR_PERMISSIONS = [
  Permission.RoomWrite,
  Permission.StorageWrite,
  Permission.LegacyRoomPresenceWrite,
  Permission.CommentsWrite,
];

type MeResponse = { user: { name: string | null; email: string; image_url: string | null } };
type ProjectResponse = { project: { role: string; name: string; image_url: string | null } };

export async function POST(request: Request) {
  const secret = process.env.LIVEBLOCKS_SECRET_KEY;
  if (!secret) {
    return NextResponse.json(
      { error: "Liveblocks is not configured on this server" },
      { status: 503 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: { roomId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const roomId = body.roomId ?? "";
  if (!roomId.startsWith(ROOM_PREFIX)) {
    return NextResponse.json({ error: "Malformed room id" }, { status: 400 });
  }
  const projectId = roomId.slice(ROOM_PREFIX.length);
  if (!projectId) {
    return NextResponse.json({ error: "Malformed room id" }, { status: 400 });
  }

  // The API is the authority on membership. If this throws, we do not mint a
  // token: an unreachable backend must never fall open.
  let me: MeResponse;
  let project: ProjectResponse["project"];
  try {
    const [meResponse, projectResponse] = await Promise.all([
      apiFetch<MeResponse>(apiPaths.me),
      apiFetch<ProjectResponse>(apiPaths.project(projectId)),
    ]);
    me = meResponse;
    project = projectResponse.project;
  } catch {
    // Deliberately does not distinguish 403 from 404 or from the API being
    // down: a caller should not learn which projects exist by probing.
    return NextResponse.json({ error: "Project not available" }, { status: 404 });
  }

  const permissions =
    project.role === "VIEWER" ? VIEWER_PERMISSIONS : EDITOR_PERMISSIONS;

  const liveblocks = new Liveblocks({ secret });
  const session = liveblocks.prepareSession(userId, {
    userInfo: {
      name: me.user.name ?? me.user.email,
      avatar: me.user.image_url ?? "",
      role: project.role,
    },
  });
  session.allow(roomId, permissions);

  // `authorize` returns { status, body, error } where `body` is a JSON *string*,
  // not an already-parsed object. Returning it verbatim would ship a quoted,
  // doubly-encoded token that the client cannot use.
  const result = await session.authorize();

  if (result.error) {
    return NextResponse.json(
      { error: result.error.message || "Could not authorize room" },
      { status: 500 },
    );
  }

  let parsed: { token?: string };
  try {
    parsed = JSON.parse(result.body) as { token?: string };
  } catch {
    return NextResponse.json({ error: "Malformed Liveblocks response" }, { status: 502 });
  }

  if (!parsed.token) {
    return NextResponse.json({ error: "No token in Liveblocks response" }, { status: 502 });
  }

  return NextResponse.json({ token: parsed.token, roomId });
}