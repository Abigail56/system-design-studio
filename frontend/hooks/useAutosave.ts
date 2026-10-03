"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { apiPaths, ApiError, browserFetch } from "@/lib/api-client";
import type { CanvasState } from "@/lib/canvas";

/**
 * Autosave.
 *
 * Debounced rather than save-on-change: dragging a node fires a change per
 * animation frame, and one POST per frame would be absurd. The delay is also
 * reset by every new change, so a burst of edits produces exactly one save when
 * the user stops.
 *
 * Uses a ref for the pending state so typing in an input never re-runs the
 * effect. Saving from an effect keyed on `state` would either fire per keystroke
 * or need a second state mirror; a ref avoids both.
 */

const SAVE_DEBOUNCE_MS = 30_000;

export type SaveState = "idle" | "saving" | "saved" | "error" | "readonly";

export function useAutosave(options: {
  projectId: string;
  state: CanvasState;
  canWrite: boolean;
  /** Bypass the debounce, for an explicit "Save now". */
  enabled?: boolean;
}) {
  const { projectId, state, canWrite, enabled = true } = options;

  const [saveState, setSaveState] = useState<SaveState>(canWrite ? "idle" : "readonly");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<CanvasState | null>(null);
  const inFlight = useRef(false);
  // Guards against saving the empty document immediately after mount.
  const dirty = useRef(false);

  const flush = useCallback(async (state?: CanvasState) => {
    if (state) pending.current = state;
    const payload = pending.current;
    if (!payload || inFlight.current) return;

    if (timer.current) clearTimeout(timer.current);
    inFlight.current = true;
    setSaveState("saving");
    setError(null);

    try {
      await browserFetch(apiPaths.snapshots(projectId), {
        method: "POST",
        body: { project_id: projectId, state: JSON.stringify(payload) },
      });
      if (pending.current === payload) pending.current = null;
      setSaveState("saved");
      setLastSavedAt(new Date());
    } catch (err) {
      setSaveState("error");
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      inFlight.current = false;
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled || !canWrite) return;

    // Nothing to save until the document differs from what was loaded.
    dirty.current = true;
    pending.current = state;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, enabled, canWrite, flush]);

  // Persist whatever is still pending if the tab goes away.
  useEffect(() => {
    const onUnload = () => {
      if (pending.current) {
        // sendBeacon survives unload; fetch with keepalive is the fallback.
        void fetch(apiPaths.snapshots(projectId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: projectId, state: JSON.stringify(pending.current) }),
          keepalive: true,
        });
      }
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [projectId]);

  return { saveState, lastSavedAt, error, saveNow: flush };
}