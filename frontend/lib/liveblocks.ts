"use client";

import { createClient } from "@liveblocks/client";

/**
 * Liveblocks client.
 *
 * Created only when a public key is configured. Everything downstream checks
 * `liveblocksEnabled` first, so the app runs single-user rather than failing to
 * connect. The `authEndpoint` points at our own route, which asks the API
 * whether the caller belongs to the room before minting a scoped token.
 */

const PUBLIC_KEY = process.env.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY;

export const liveblocksEnabled =
  typeof PUBLIC_KEY === "string" && PUBLIC_KEY.startsWith("pk_");

export const liveblocksClient = liveblocksEnabled
  ? createClient({
      authEndpoint: "/api/liveblocks/auth",
      // Back off between reconnect attempts rather than hammering a
      // misconfigured auth endpoint.
      throttle: 1000,
      lostConnectionTimeout: 30000,
    })
  : null;

export const roomIdFor = (projectId: string) => `project:${projectId}`;

/**
 * Stable colour per connection id, so the same collaborator keeps the same
 * cursor colour for the whole session.
 */
export const CURSOR_COLORS = [
  "#e11d48",
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#db2777",
  "#0891b2",
  "#65a30d",
];

export function colorFor(id: number | string): string {
  const numeric = typeof id === "number" ? id : Number(String(id)) || 0;
  return CURSOR_COLORS[Math.abs(numeric) % CURSOR_COLORS.length];
}