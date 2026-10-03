"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { browserFetch, apiPaths, ApiError } from "@/lib/api-client";
import type { Project } from "@/lib/types";

/** Inline create form. Collapsed to a single button so the page stays quiet. */
export function CreateProjectForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-fg)] shadow-[var(--shadow-sm)] transition-all hover:-translate-y-0.5 hover:bg-[var(--accent-hover)] hover:shadow-[var(--shadow)]"
      >
        <span aria-hidden className="text-lg leading-none">+</span>
        Start a project
      </button>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the project a name");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const { project } = await browserFetch<{ project: Project }>(apiPaths.projects, {
        method: "POST",
        body: { name: name.trim(), description: description.trim() || null },
      });

      setOpen(false);
      setName("");
      setDescription("");
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create project");
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="surface-card w-full rounded-2xl p-5 sm:w-96"
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Start a new project</h2>
          <p className="mt-0.5 text-xs text-[var(--fg-muted)]">Give your canvas a name to get started.</p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Cancel"
          className="grid size-8 place-items-center rounded-lg text-lg text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--fg)]"
        >
          <span aria-hidden>×</span>
        </button>
      </div>

      <label className="mb-1.5 block text-xs font-medium text-[var(--fg)]" htmlFor="project-name">
        Project name
      </label>
      <input
        id="project-name"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Payments platform"
        className="mb-4 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)]"
      />

      <label
        className="mb-1.5 block text-xs font-medium text-[var(--fg)]"
        htmlFor="project-description"
      >
        What are you working on? <span className="font-normal text-[var(--fg-subtle)]">(optional)</span>
      </label>
      <textarea
        id="project-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="What are you designing?"
        className="mb-4 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)]"
      />

      {error ? <p className="mb-3 text-xs text-[var(--danger)]">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-3 py-2 text-sm text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-inset)] hover:text-[var(--fg)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}