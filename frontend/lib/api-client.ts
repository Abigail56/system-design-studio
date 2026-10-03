/**
 * Isomorphic API client. Safe to import from both Server and Client Components,
 * so it must never pull in `@clerk/nextjs/server` (that module is marked
 * `server-only` and breaks the client bundle).
 *
 * For server-side calls use `apiFetch` from `./api-server` instead.
 *
 * Auth: Clerk owns the session. The Python service verifies the Clerk session
 * JWT itself, so every request forwards `Authorization: Bearer <session token>`.
 */

import { getToken } from "@clerk/nextjs";

const DEFAULT_BASE_URL =
  process.env.NEXT_PUBLIC_GHOST_API_URL?.replace(/\/$/, "") ??
  "http://localhost:8000";

/**
 * Must match `DEV_AUTH` in the API. Read through `NEXT_PUBLIC_` because this
 * module is imported by Client Components, where unprefixed vars are not
 * inlined; the API ignores the token entirely in this mode and identifies the
 * caller from its own config, so no header is needed.
 */
export function devAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEV_AUTH === "true";
}

/** Resolved lazily: env vars are inlined at build, so reading it at module
 *  scope is fine in the browser but not in a test that overrides it. */
export function apiBaseUrl(): string {
  return DEFAULT_BASE_URL;
}

/** Error carrying the HTTP status so callers can distinguish 401/403/404. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
};

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error === "string") return body.error;
    return `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
  const base = DEFAULT_BASE_URL;
  const url = new URL(path.startsWith("/") ? `${base}${path}` : `${base}/${path}`, base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function request<T>(
  path: string,
  token: string | null,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  const url = buildUrl(path, options.query);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Auth lives in the Authorization header, never a cookie, so the Next.js
      // server cache must not serve one user's response to another.
      cache: "no-store",
    });
  } catch (err) {
    // A blocked CORS preflight rejects with a bare `TypeError: Failed to
    // fetch`, indistinguishable from the API being down. Name the likely cause
    // instead of surfacing something the caller cannot act on.
    if (err instanceof TypeError) {
      throw new ApiError(
        `Could not reach the API at ${new URL(url).origin}. If the app is open ` +
          `via localhost, check the API's CORS_ORIGINS includes this exact origin.`,
        0,
      );
    }
    throw err;
  }

  if (!response.ok) throw new ApiError(await readError(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Call the API from a Client Component.
 *
 * In dev auth there is no Clerk session and no `<ClerkProvider>`, so `getToken`
 * is never called; the API accepts the bypass token and identifies the caller
 * from its own env config instead.
 */
export async function browserFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = devAuthEnabled() ? null : await getToken();
  return request<T>(path, token, options);
}

export const apiPaths = {
  me: "/v1/me",
  projects: "/v1/projects",
  project: (id: string) => `/v1/projects/${id}`,
  invites: (id: string) => `/v1/projects/${id}/invites`,
  revokeInvite: (projectId: string, inviteId: string) =>
    `/v1/projects/${projectId}/invites/${inviteId}`,
  removeMember: (projectId: string, userId: string) =>
    `/v1/projects/${projectId}/members/${userId}`,
  snapshots: (id: string) => `/v1/projects/${id}/snapshots`,
  snapshot: (projectId: string, snapshotId: string) =>
    `/v1/projects/${projectId}/snapshots/${snapshotId}`,
  snapshotContent: (projectId: string, snapshotId: string) =>
    `/v1/projects/${projectId}/snapshots/${snapshotId}/content`,
  aiStatus: "/v1/ai/status",
  aiModels: "/v1/ai/models",
  chat: "/v1/ai/chat",
  generate: "/v1/ai/generate",
  spec: "/v1/ai/spec",
  task: (id: string) => `/v1/ai/tasks/${id}`,
};