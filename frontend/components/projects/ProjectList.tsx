"use client";

import Link from "next/link";
import { formatRelativeTime, type Project } from "@/lib/types";
import type { Role } from "@/lib/types";

const ROLE_STYLES: Record<Role, string> = {
  OWNER: "bg-[var(--accent-soft)] text-[var(--accent)]",
  EDITOR: "bg-[var(--success)]/10 text-[var(--success)]",
  VIEWER: "bg-[var(--bg-inset)] text-[var(--fg-muted)]",
};

export function ProjectList({ projects }: { projects: Project[] }) {
  if (projects.length === 0) {
    return (
      <div className="surface-card relative overflow-hidden rounded-3xl px-6 py-16 text-center sm:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 size-56 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)]/10 blur-3xl"
        />
        <span className="relative mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <rect x="3" y="4" width="7" height="6" rx="1.5" />
            <rect x="14" y="14" width="7" height="6" rx="1.5" />
            <path d="M10 7h3a2 2 0 0 1 2 2v5M7 10v3a2 2 0 0 0 2 2h5" />
          </svg>
        </span>
        <p className="editorial-heading relative text-2xl font-medium">
          Your first canvas is waiting
        </p>
        <p className="relative mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--fg-muted)]">
          Start with a system you have in mind. Invite your team when you’re ready
          and build the design together.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <li key={project.id}>
          <Link
            href={`/projects/${project.id}`}
            className="group surface-card relative flex h-full min-h-56 flex-col overflow-hidden rounded-3xl p-6 transition-all duration-200 hover:-translate-y-1 hover:border-[var(--accent)]/35 hover:shadow-[var(--shadow-lg)]"
          >
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[var(--accent-soft)] to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
            />
            <div className="relative flex items-start justify-between gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-[var(--bg-inset)] text-[var(--accent)] transition-colors group-hover:border-[var(--accent)]/30 group-hover:bg-[var(--accent-soft)]">
                <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <rect x="3" y="4" width="7" height="6" rx="1.5" />
                  <rect x="14" y="14" width="7" height="6" rx="1.5" />
                  <path d="M10 7h3a2 2 0 0 1 2 2v5M7 10v3a2 2 0 0 0 2 2h5" />
                </svg>
              </span>
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide ${ROLE_STYLES[project.role]}`}
              >
                {project.role === "OWNER" ? "Owner" : project.role === "EDITOR" ? "Editor" : "Viewer"}
              </span>
            </div>

            <div className="relative mt-6 flex-1">
              <h2 className="editorial-heading line-clamp-1 text-xl font-medium leading-snug">
                {project.name}
              </h2>
              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[var(--fg-muted)]">
                {project.description || "A shared canvas for your next system design."}
              </p>
            </div>

            <div className="relative mt-5 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-4 text-xs text-[var(--fg-subtle)]">
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M13.5 17v-1.5A2.5 2.5 0 0 0 11 13H5a2.5 2.5 0 0 0-2.5 2.5V17M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14 4.2a3 3 0 0 1 0 5.8m1.5 3h.5a2.5 2.5 0 0 1 2.5 2.5V17" />
                </svg>
                {project.member_count} {project.member_count === 1 ? "person" : "people"}
              </span>
              <span className="tnum">Updated {formatRelativeTime(project.updated_at)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}