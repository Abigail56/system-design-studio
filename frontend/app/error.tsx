"use client";

import Link from "next/link";
import { ApiError } from "@/lib/api-client";
import { UserMenu } from "@/components/layout/UserMenu";

/**
 * Catches errors thrown by `apiFetch` in server components as well as anything
 * unexpected. Status-specific messaging so a 403 does not read like a crash.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const status = error instanceof ApiError ? error.status : 500;

  const heading =
    status === 401
      ? "Sign in required"
      : status === 403
        ? "No access"
        : status === 404
          ? "Not found"
          : status >= 500
            ? "The API is unreachable"
            : "Something went wrong";

  const detail =
    error instanceof ApiError
      ? error.message
      : status >= 500 && !(error instanceof ApiError)
        ? "The backend did not respond. Check that the FastAPI service is running and GHOST_API_URL is correct."
        : "An unexpected error occurred. Check the server logs for details.";

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
          {status}
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{heading}</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">{detail}</p>

        <div className="mt-6 flex items-center justify-center gap-3">
          {status === 401 ? (
            <Link
              href="/sign-in"
              className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Sign in
            </Link>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--bg-raised)]"
            >
              Try again
            </button>
          )}
          <Link href="/projects" className="text-sm text-[var(--fg-muted)] hover:underline">
            All projects
          </Link>
        </div>

        <div className="mt-8 flex justify-center">
          <UserMenu />
        </div>
      </div>
    </div>
  );
}