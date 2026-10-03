"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserFetch, apiPaths, ApiError } from "@/lib/api-client";
import { formatRelativeTime, type ProjectInvite } from "@/lib/types";

/**
 * Invites for emails that have not signed up yet. These redeem automatically
 * when that address first authenticates.
 */
export function InviteList({ projectId, invites }: { projectId: string; invites: ProjectInvite[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (invites.length === 0) return null;

  async function revoke(inviteId: string) {
    setBusyId(inviteId);
    setError(null);
    try {
      await browserFetch(apiPaths.revokeInvite(projectId, inviteId), { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke invite");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] p-4">
      <h3 className="text-sm font-medium">Pending invites</h3>
      <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
        No email is sent automatically. These join when they sign in with the invited email.
      </p>

      <ul className="mt-3 space-y-1.5">
        {invites.map((invite) => (
          <li key={invite.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="truncate">{invite.email}</span>
            <span className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-muted)]">
              {invite.role === "EDITOR" ? "Can edit" : "Can view"}
            </span>
            <span className="shrink-0 text-xs text-[var(--fg-muted)]">
              invited {formatRelativeTime(invite.created_at)}
            </span>
            <button
              type="button"
              onClick={() => revoke(invite.id)}
              disabled={busyId === invite.id}
              className="shrink-0 text-xs text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--danger)] hover:underline disabled:opacity-50"
            >
              {busyId === invite.id ? "Revoking…" : "Revoke"}
            </button>
          </li>
        ))}
      </ul>

      {error ? <p className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}