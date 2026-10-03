"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserFetch, apiPaths, ApiError } from "@/lib/api-client";
import type { Role } from "@/lib/types";
import { UserPlusIcon } from "@/components/icons";

/**
 * Invites a collaborator by email. Known users become members immediately;
 * unknown emails are stored as pending invites and redeem on first sign-in.
 */
export function InviteMemberForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Extract<Role, "EDITOR" | "VIEWER">>("VIEWER");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          <UserPlusIcon className="size-4" />
          Invite
        </button>
        {notice ? (
          <p role="status" className="mt-2 max-w-sm text-xs leading-relaxed text-[var(--fg-muted)]">
            {notice}
          </p>
        ) : null}
      </div>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await browserFetch<{
        notification_sent: boolean;
        notification_message: string;
        invite?: unknown;
        member?: unknown;
      }>(apiPaths.invites(projectId), {
        method: "POST",
        body: { email: email.trim(), role },
      });
      setNotice(result.notification_message);
      setOpen(false);
      setEmail("");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send invite");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full sm:w-auto">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="w-64 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "EDITOR" | "VIEWER")}
          className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-sm outline-none focus:border-[var(--accent)]"
        >
          <option value="VIEWER">Can view</option>
          <option value="EDITOR">Can edit</option>
        </select>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Create invite"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-2 py-2 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Cancel
        </button>
      </div>

      {error ? <p className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
      <p className="mt-2 text-xs text-[var(--fg-muted)]">
        We’ll show whether the invitation email was accepted for delivery. The recipient must
        sign in with this email address to join.
      </p>
    </form>
  );
}