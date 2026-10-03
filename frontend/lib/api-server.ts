import "server-only";

/**
 * Server-side API client for Server Components and Route Handlers.
 *
 * Separate from `api-client.ts` because `@clerk/nextjs/server` is marked
 * `server-only`. Sharing one module between server and client components makes
 * `next build` fail with "'server-only' cannot be imported from a Client
 * Component module" the moment a client component imports anything else from
 * that file.
 */

import { auth } from "@clerk/nextjs/server";

import { request, type RequestOptions } from "@/lib/api-client";

/** Matches `api/config.py`'s `dev_auth_clerk_id`; the API ignores the value. */
const DEV_AUTH_TOKEN = "dev-auth-bypass";

function devAuthEnabled(): boolean {
  return process.env.DEV_AUTH === "true";
}

/** Call the API from a Server Component or Route Handler. */
export async function apiFetch<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  if (devAuthEnabled()) {
    return request<T>(path, DEV_AUTH_TOKEN, options);
  }

  const { getToken } = await auth();
  const token = await getToken();
  return request<T>(path, token, options);
}