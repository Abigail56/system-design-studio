"use client";

import { useState } from "react";

import { apiPaths, ApiError, browserFetch } from "@/lib/api-client";
import { formatRelativeTime, type Snapshot } from "@/lib/types";
import { parseCanvasState, type CanvasState } from "@/lib/canvas";

/**
 * Snapshot history and restore.
 *
 * The list arrives as a prop from the Server Component rather than being fetched
 * on mount: this app is server-first, and fetching in an effect would both
 * duplicate the request and add a client round trip before anything renders.
 * The component owns only the restore interaction, which needs the browser.
 */
export function SnapshotHistory({
  projectId,
  snapshots,
  onRestore,
  onErase,
  canRestore,
}: {
  projectId: string;
  snapshots: Snapshot[];
  onRestore: (state: CanvasState) => void;
  onErase: () => Promise<void>;
  canRestore: boolean;
}) {
  const [list, setList] = useState(snapshots);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const response = await browserFetch<{ state: string }>(
        apiPaths.snapshotContent(projectId, id),
      );
      const parsed = parseCanvasState(response.state);
      if (!parsed) {
        setError("That snapshot could not be read");
        return;
      }
      // Restoring replaces the whole document, so confirm before discarding
      // anything not yet autosaved.
      if (!window.confirm("Replace the current canvas with this snapshot?")) return;

      onRestore(parsed);

      // A restore is itself a change, so show it at the top of the history.
      setList((current) =>
        current.some((s) => s.id === id)
          ? current
          : [
              {
                ...current[0],
                id,
                created_at: new Date().toISOString(),
              },
              ...current,
            ],
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not restore snapshot");
    } finally {
      setBusyId(null);
    }
  }

  async function removeSnapshot(id: string) {
    if (!window.confirm("Delete this saved version? This cannot be undone.")) return;
    setBusyId(id);
    setError(null);
    try {
      await browserFetch(apiPaths.snapshot(projectId, id), { method: "DELETE" });
      setList((current) => current.filter((snapshot) => snapshot.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete snapshot");
    } finally {
      setBusyId(null);
    }
  }

  async function clearHistory() {
    if (!window.confirm("Clear all saved versions for this project? This cannot be undone.")) {
      return;
    }
    setClearing(true);
    setError(null);
    try {
      await browserFetch(apiPaths.snapshots(projectId), { method: "DELETE" });
      setList([]);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not clear snapshot history");
    } finally {
      setClearing(false);
    }
  }

  async function eraseCanvas() {
    if (!window.confirm("Erase every component and connection from the current canvas?")) return;
    setErasing(true);
    setError(null);
    try {
      await onErase();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not erase the canvas");
    } finally {
      setErasing(false);
    }
  }

  return (
    <section className="relative">
      <div className="flex gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="snapshot-history-list"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--bg-raised)]/95 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)] shadow-[var(--shadow-sm)] backdrop-blur hover:text-[var(--fg)]"
        >
          <span>History ({list.length})</span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
        {canRestore ? (
          <button
            type="button"
            onClick={() => void eraseCanvas()}
            disabled={erasing}
            className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--bg-raised)]/95 px-3 py-2.5 text-xs font-medium text-[var(--danger)] shadow-[var(--shadow-sm)] backdrop-blur hover:bg-[var(--danger)]/10 disabled:opacity-50"
            title="Erase all components and connections from the current canvas"
          >
            {erasing ? "Erasing…" : "Erase canvas"}
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          id="snapshot-history-list"
          className="absolute bottom-full left-0 z-20 mb-3 max-h-72 w-full overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-raised)] p-3 shadow-lg backdrop-blur"
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              Previous versions
            </h2>
            {canRestore && list.length > 0 ? (
              <button
                type="button"
                onClick={() => void clearHistory()}
                disabled={clearing || busyId !== null}
                className="text-[10px] text-[var(--danger)] underline-offset-2 hover:underline disabled:opacity-50"
              >
                {clearing ? "Clearing…" : "Clear history"}
              </button>
            ) : null}
          </div>

          {list.length === 0 ? (
            <p className="rounded-md border border-dashed border-[var(--border)] px-2.5 py-3 text-center text-[11px] text-[var(--fg-muted)]">
              Nothing saved yet. The canvas saves itself after you stop editing.
            </p>
          ) : (
            <ul className="space-y-1">
              {list.slice(0, 10).map((snapshot) => (
                <li
                  key={snapshot.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs">
                      {formatRelativeTime(snapshot.created_at)}
                    </p>
                    <p className="truncate text-[10px] text-[var(--fg-muted)]">
                      {snapshot.created_by.name ?? snapshot.created_by.email}
                      {snapshot.storage === "inline" ? " · in db" : ""}
                    </p>
                  </div>

                  {canRestore ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => restore(snapshot.id)}
                        disabled={busyId !== null || clearing}
                        className="text-[11px] text-[var(--fg-muted)] underline-offset-2 hover:text-[var(--accent)] hover:underline disabled:opacity-50"
                      >
                        {busyId === snapshot.id ? "…" : "Restore"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeSnapshot(snapshot.id)}
                        disabled={busyId !== null || clearing}
                        className="text-[11px] text-[var(--danger)] underline-offset-2 hover:underline disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {error ? <p className="mt-2 text-[11px] text-[var(--danger)]">{error}</p> : null}
    </section>
  );
}