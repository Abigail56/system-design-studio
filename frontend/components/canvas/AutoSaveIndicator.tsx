"use client";

import { formatRelativeTime } from "@/lib/types";
import type { SaveState } from "@/hooks/useAutosave";

const LABELS: Record<SaveState, string> = {
  idle: "All changes saved",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
  readonly: "View only",
};

/**
 * Autosave status.
 *
 * Deliberately quiet: it sits above the canvas and should not compete with it
 * for attention. Errors are the only state that gets colour.
 */
export function AutoSaveIndicator({
  saveState,
  lastSavedAt,
  error,
  onRetry,
}: {
  saveState: SaveState;
  lastSavedAt: Date | null;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="pointer-events-none absolute right-5 top-5 z-10 flex items-center gap-2">
      {error ? (
        <>
          <span className="rounded-full border border-[var(--danger)]/20 bg-[var(--bg-raised)] px-3 py-1.5 text-[11px] font-medium text-[var(--danger)] shadow-[var(--shadow-sm)]">
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="pointer-events-auto rounded-full border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-[11px] font-medium shadow-[var(--shadow-sm)] hover:bg-[var(--bg)]"
          >
            Retry
          </button>
        </>
      ) : (
        <span
          className={`rounded-full border border-[var(--border)] bg-[var(--bg-raised)]/95 px-3 py-1.5 text-[11px] font-medium text-[var(--fg-muted)] shadow-[var(--shadow-sm)] backdrop-blur ${
            saveState === "saving" ? "animate-pulse" : ""
          }`}
        >
          {LABELS[saveState]}
          {saveState === "saved" && lastSavedAt
            ? ` · ${formatRelativeTime(lastSavedAt.toISOString())}`
            : ""}
        </span>
      )}
    </div>
  );
}