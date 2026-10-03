"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { browserFetch, apiPaths, ApiError } from "@/lib/api-client";
import type { ProjectMember, Role } from "@/lib/types";

const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  EDITOR: "Can edit",
  VIEWER: "Can view",
};

/** Hashed background per member so avatars stay distinguishable without images. */
const AVATAR_COLORS = [
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-sky-500",
  "bg-rose-500",
  "bg-violet-500",
];

export function MemberList({
  projectId,
  viewerId,
  viewerRole,
  ownerId,
  members,
}: {
  projectId: string;
  viewerId: string;
  viewerRole: Role;
  ownerId: string;
  members: ProjectMember[];
}) {
  const router = useRouter();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = viewerRole === "OWNER";

  async function remove(userId: string) {
    setRemovingId(userId);
    setError(null);
    try {
      await browserFetch(apiPaths.removeMember(projectId, userId), { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove member");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {members.map((member, index) => {
          const isOwner = member.user.id === ownerId;
          const initials = (member.user.name ?? member.user.email)
            .split(/\s|@/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase())
            .join("");

          return (
            <li key={member.id} className="flex items-center gap-3 px-4 py-3">
              {member.user.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={member.user.image_url}
                  alt=""
                  className="size-8 shrink-0 rounded-full object-cover"
                />
              ) : (
                <span
                  className={`grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold text-white ${AVATAR_COLORS[index % AVATAR_COLORS.length]}`}
                >
                  {initials || "?"}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.user.name ?? member.user.email}
                  {member.user.id === viewerId ? (
                    <span className="ml-1.5 text-xs text-[var(--fg-muted)]">(you)</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-[var(--fg-muted)]">{member.user.email}</p>
              </div>

              <span className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--fg-muted)]">
                {ROLE_LABEL[isOwner ? "OWNER" : member.role]}
              </span>

              {canManage && !isOwner ? (
                <button
                  type="button"
                  onClick={() => remove(member.user.id)}
                  disabled={removingId === member.user.id}
                  className="shrink-0 text-xs text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--danger)] hover:underline disabled:opacity-50"
                >
                  {removingId === member.user.id ? "Removing…" : "Remove"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? <p className="mt-2 text-xs text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}