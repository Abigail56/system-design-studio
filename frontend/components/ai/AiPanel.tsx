"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { apiPaths, ApiError, browserFetch } from "@/lib/api-client";
import {
  streamChat,
  type AiModel,
  type ChatTurn,
  type PanelTurn,
} from "@/lib/ai-chat";
import { useCanvas } from "@/components/canvas/CanvasDocumentProvider";
import { SparklesIcon } from "@/components/icons";
import type { CanvasState } from "@/lib/canvas";

type AiStatus = {
  available: boolean;
  provider: string | null;
  model: string | null;
};
type DiagramType = "architecture" | "erd";
const MAX_CHAT_MODELS = 3;
const MAX_GENERATION_PROMPT_LENGTH = 30000;
const MAX_CHAT_MESSAGE_LENGTH = 4500;

type Tab = "ai" | "people";

/**
 * Read at module scope, not inside the component: it is inlined at build time in
 * a Client Component, and `AiPanel` branches on it to pick a token source.
 */
const devAuth = process.env.NEXT_PUBLIC_DEV_AUTH === "true";

/**
 * The right-hand workspace sidebar: AI on one tab, people on the other.
 *
 * The AI panel lives inside `CanvasDocumentProvider` so that a generated
 * diagram can be written straight into the shared document rather than routed
 * back out through a callback.
 */
export function AiPanel(props: {
  projectId: string;
  /** The collaborators panel, rendered under the People tab. */
  children: React.ReactNode;
}) {
  // `useAuth()` throws without a `<ClerkProvider>`, which the layout omits in
  // dev-auth mode, so the token source is chosen by a wrapper rather than an
  // early return inside the component that needs the hook.
  if (devAuth) return <AiPanelBody {...props} getToken={async () => null} />;
  return <ClerkTokenPanel {...props} />;
}

function ClerkTokenPanel(props: {
  projectId: string;
  children: React.ReactNode;
}) {
  const { getToken } = useAuth();
  return <AiPanelBody {...props} getToken={getToken} />;
}

function AiPanelBody({
  projectId,
  children,
  getToken,
}: {
  projectId: string;
  children: React.ReactNode;
  /** Resolves the Clerk session JWT, or null in dev auth where there is none. */
  getToken: () => Promise<string | null>;
}) {
  const [tab, setTab] = useState<Tab>("ai");
  const doc = useCanvas();

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [chatQuestion, setChatQuestion] = useState("");
  const [turns, setTurns] = useState<PanelTurn[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [diagramType, setDiagramType] = useState<DiagramType>("architecture");
  const [modelSearch, setModelSearch] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [busy, setBusy] = useState<"generate" | "spec" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  async function loadModels() {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const values = await browserFetch<AiModel[]>(apiPaths.aiModels);
      setModels(values);
      if (status?.model && values.some((model) => model.id === status.model)) {
        setSelectedModels((current) => current.length ? current : [status.model!]);
      }
    } catch (err) {
      setModelsError(err instanceof ApiError ? err.message : "Could not load OpenRouter models");
    } finally {
      setModelsLoading(false);
    }
  }

  // Whether AI can run at all, so the controls disable with a reason instead of
  // failing on click. OpenRouter's live catalog supplies the model picker.
  useEffect(() => {
    let cancelled = false;
    browserFetch<AiStatus>(apiPaths.aiStatus)
      .then((value) => {
        if (cancelled) return;
        setStatus(value);
        if (value.available && value.provider === "openrouter") {
          browserFetch<AiModel[]>("/v1/ai/models")
            .then((availableModels) => {
              if (cancelled) return;
              setModels(availableModels);
              if (value.model && availableModels.some((model) => model.id === value.model)) {
                setSelectedModels([value.model]);
              }
            })
            .catch((err: unknown) => {
              if (!cancelled) {
                setModelsError(
                  err instanceof ApiError ? err.message : "Could not load OpenRouter models",
                );
              }
            });
        }
      })
      .catch(() => {
        // Leave `available` false; the panel explains it.
        if (!cancelled) {
          setStatus({
            available: false,
            provider: null,
            model: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // Abort any in-flight stream when the panel unmounts, or the server keeps
  // generating a response nobody is reading.
  useEffect(() => () => abort.current?.abort(), []);

  const available = status?.available ?? false;
  const generationAvailable = available;

  async function send(message: string) {
    if (!message.trim() || streaming) return;

    const history: ChatTurn[] = turns.slice(-10).map((turn) => ({
      role: turn.role,
      content: turn.responses?.length
        ? turn.responses
            .filter((response) => response.content)
            .map((response) => `${response.model}: ${response.content}`)
            .join("\n\n")
        : turn.content,
    }));
    const responseModels =
      status?.provider === "openrouter" ? selectedModels.slice(0, MAX_CHAT_MODELS) : [];
    const responses = responseModels.length ? responseModels.map((model) => ({
      model,
      content: "",
      done: false,
    })) : undefined;
    setTurns((current) => [
      ...current,
      { role: "user", content: message },
      { role: "assistant", content: "", responses },
    ]);
    setStreaming(true);
    setError(null);

    const controller = new AbortController();
    abort.current = controller;

    try {
      const token = await getToken();
      await streamChat({
        projectId,
        message,
        history,
        models: responseModels,
        // Dev auth has no Clerk session, so there is no token to forward.
        token: token ?? "dev-auth-bypass",
        signal: controller.signal,
        onDelta: (model, chunk) => {
          setTurns((current) => {
            const next = current.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = {
              ...last,
              content: last.content + chunk,
              responses: last.responses?.map((response) =>
                response.model === model
                  ? { ...response, content: response.content + chunk }
                  : response,
              ),
            };
            return next;
          });
        },
        onModelDone: (model) => {
          setTurns((current) => {
            const next = current.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = {
              ...last,
              responses: last.responses?.map((response) =>
                response.model === model ? { ...response, done: true } : response,
              ),
            };
            return next;
          });
        },
        onModelError: (model, responseError) => {
          setTurns((current) => {
            const next = current.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = {
              ...last,
              responses: last.responses?.map((response) =>
                response.model === model
                  ? { ...response, error: responseError, done: true }
                  : response,
              ),
            };
            return next;
          });
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // User navigated away; drop the empty placeholder turn.
        setTurns((t) => (t.at(-1)?.content === "" ? t.slice(0, -1) : t));
      } else {
        setError(err instanceof ApiError ? err.message : "Could not reach the assistant");
      }
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }

  async function generate() {
    if (!prompt.trim() || !doc.canWrite || !generationAvailable) return;
    setBusy("generate");
    setError(null);
    setNotice(null);

    try {
      const result = await browserFetch<{ nodes: CanvasState["nodes"]; edges: CanvasState["edges"] }>(
        apiPaths.generate,
        {
          method: "POST",
          body: {
            project_id: projectId,
            prompt: prompt.trim(),
            diagram_type: diagramType,
          },
        },
      );
      // Straight into the shared document, so it syncs to everyone and the
      // autosave hook picks it up like any other edit.
      doc.replaceAll({ nodes: result.nodes, edges: result.edges });
      setPrompt("");
      setNotice(
        `Placed ${result.nodes.length} components and ${result.edges.length} connections.`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not generate a design");
    } finally {
      setBusy(null);
    }
  }

  async function exportSpec() {
    setBusy("spec");
    setError(null);
    try {
      const result = await browserFetch<{ spec: string }>(apiPaths.spec, {
        method: "POST",
        body: { project_id: projectId },
      });
      // A Blob URL avoids routing markdown through a chat transcript.
      const blob = new Blob([result.spec], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "design-spec.md";
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Spec downloaded.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not write a spec");
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="flex h-full w-[25rem] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--bg-raised)] shadow-[-12px_0_32px_-28px_rgb(0_0_0_/_0.35)]">
      <div role="tablist" className="flex shrink-0 border-b border-[var(--border)] bg-[var(--bg-raised)] px-3">
        {(["ai", "people"] as const).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex-1 px-4 py-3.5 text-xs font-semibold capitalize tracking-wide transition-colors ${
              tab === key
                ? "border-b-2 border-[var(--accent)] text-[var(--fg)]"
                : "border-b-2 border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]"
            }`}
          >
            {key === "ai" ? "Assistant" : "People"}
          </button>
        ))}
      </div>

      {tab === "ai" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            {turns.length === 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[linear-gradient(145deg,var(--accent-soft),transparent_75%)] p-5">
                <span className="mb-3 grid size-9 place-items-center rounded-xl bg-[var(--bg-raised)] text-[var(--accent)] shadow-[var(--shadow-sm)]">
                  <SparklesIcon className="size-4" />
                </span>
                <p className="text-[15px] font-semibold tracking-tight">A thinking partner for your design</p>
                <p className="mt-2 text-[13px] leading-6 text-[var(--fg-muted)]">
                  The assistant sees the current canvas, so it can explain a
                  component, suggest a change, or review the whole diagram.
                </p>
              </div>
            ) : null}

            {turns.map((turn, index) => (
              <div
                key={index}
                className={
                  turn.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                {turn.role === "assistant" && turn.responses?.length ? (
                  <div className="w-full space-y-2">
                    {turn.responses.map((response) => (
                      <section
                        key={response.model}
                        className="rounded-xl border border-[var(--border)] bg-[var(--bg-overlay)] px-4 py-3 text-[13px] leading-relaxed shadow-[var(--shadow-sm)]"
                      >
                        <p className="mb-1 text-[10px] font-semibold text-[var(--fg-muted)]">
                          {models.find((model) => model.id === response.model)?.name ??
                            response.model}
                        </p>
                        {response.error ? (
                          <p className="text-[var(--danger)]">{response.error}</p>
                        ) : (
                          <p className="whitespace-pre-wrap">
                            {response.content || (streaming && !response.done ? "…" : "")}
                          </p>
                        )}
                      </section>
                    ))}
                  </div>
                ) : <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
                    turn.role === "user"
                      ? "rounded-2xl bg-[var(--accent-soft)] text-[var(--fg)]"
                      : "border border-[var(--border)] bg-[var(--bg-overlay)] text-[var(--fg)] shadow-[var(--shadow-sm)]"
                  }`}
                >
                  {turn.content || (streaming ? "…" : "")}
                </div>}
              </div>
            ))}

            {notice ? (
              <p className="rounded-md bg-[var(--accent-soft)] px-3 py-2 text-xs text-[var(--accent)]">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-md bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger)]">
                {error}
              </p>
            ) : null}
          </div>

          {/* Generation controls */}
          <div className="shrink-0 space-y-2.5 border-t border-[var(--border)] bg-[var(--bg-raised)] p-4">
            {!available && !devAuth ? (
              <p className="rounded-md bg-[var(--bg-inset)] px-3 py-2 text-[11px] leading-relaxed text-[var(--fg-muted)]">
                No AI provider is configured. Set{" "}
                <code className="font-mono text-[var(--fg)]">OPENROUTER_API_KEY</code>,{" "}
                <code className="font-mono text-[var(--fg)]">OPENAI_API_KEY</code> or{" "}
                <code className="font-mono text-[var(--fg)]">ANTHROPIC_API_KEY</code> in the
                API environment, then restart it.
              </p>
            ) : null}

            {status?.provider === "openrouter" ? (
              <div className="space-y-1.5">
                <label className="block text-[11px] font-medium text-[var(--fg-muted)]">
                  Models (choose up to {MAX_CHAT_MODELS}; each model receives this prompt)
                </label>
                <input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  disabled={streaming || modelsLoading || models.length === 0}
                  placeholder="Search models…"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-50"
                />
                {modelsLoading ? (
                  <p className="text-[11px] text-[var(--fg-muted)]">Loading OpenRouter models…</p>
                ) : modelsError ? (
                  <div className="space-y-1 text-[11px] text-[var(--danger)]">
                    <p>{modelsError}</p>
                    <button type="button" onClick={() => void loadModels()} className="underline">
                      Retry loading models
                    </button>
                  </div>
                ) : (
                  <div className="max-h-28 space-y-1 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg)] p-2">
                    {models
                      .filter((model) =>
                        `${model.name} ${model.id}`
                          .toLowerCase()
                          .includes(modelSearch.trim().toLowerCase()),
                      )
                      .slice(0, 100)
                      .map((model) => (
                        <label key={model.id} className="flex items-start gap-2 text-[11px]">
                          <input
                            type="checkbox"
                            checked={selectedModels.includes(model.id)}
                            disabled={
                              streaming ||
                              (!selectedModels.includes(model.id) &&
                                selectedModels.length >= MAX_CHAT_MODELS)
                            }
                            onChange={(event) => {
                              setSelectedModels((current) =>
                                event.target.checked
                                  ? [...current, model.id].slice(0, MAX_CHAT_MODELS)
                                  : current.filter((id) => id !== model.id),
                              );
                            }}
                            className="mt-0.5 accent-[var(--accent)]"
                          />
                          <span className="min-w-0 break-words">
                            {model.name}
                            <span className="block font-mono text-[9px] text-[var(--fg-subtle)]">
                              {model.id}
                            </span>
                          </span>
                        </label>
                      ))}
                  </div>
                )}
                <p className="text-[10px] text-[var(--fg-subtle)]">
                  {selectedModels.length
                    ? `${selectedModels.length} selected. Comparing models may use more credits.`
                    : "No models selected; the configured default model will answer."}
                </p>
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
                Diagram
                <select
                  value={diagramType}
                  onChange={(event) => setDiagramType(event.target.value as DiagramType)}
                  disabled={busy !== null}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="architecture">Architecture</option>
                  <option value="erd">ERD</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-[11px] font-medium text-[var(--fg-muted)]">
                Generator
                <span className="flex min-h-9 items-center rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--fg)]">
                  Configured AI
                </span>
              </label>
            </div>

            <textarea
              value={prompt}
              maxLength={MAX_GENERATION_PROMPT_LENGTH}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void generate();
                }
              }}
              rows={2}
              disabled={!generationAvailable || busy !== null}
              placeholder={
                diagramType === "erd"
                  ? "Model a library system with books, authors, and loans…"
                  : "Design a URL shortener…"
              }
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-50"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void generate()}
                disabled={!generationAvailable || !doc.canWrite || busy !== null || !prompt.trim()}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                <SparklesIcon className="size-3.5" />
                {busy === "generate"
                  ? "Designing…"
                  : `Generate ${diagramType === "erd" ? "ERD" : "architecture"}`}
              </button>
              <button
                type="button"
                onClick={() => void exportSpec()}
                disabled={!available || busy !== null}
                title="Write a markdown spec from the current diagram"
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--bg-overlay)] disabled:opacity-50"
              >
                {busy === "spec" ? "Writing…" : "Export spec"}
              </button>
            </div>

            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = chatQuestion;
                setChatQuestion("");
                void send(value);
              }}
            >
              <input
                type="text"
                value={chatQuestion}
                maxLength={MAX_CHAT_MESSAGE_LENGTH}
                onChange={(event) => setChatQuestion(event.target.value)}
                disabled={!available || streaming}
                placeholder="Ask a question about this design…"
                aria-label="Ask a question about this design"
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px] outline-none transition-colors placeholder:text-[var(--fg-subtle)] focus:border-[var(--accent)] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!available || streaming || !chatQuestion.trim()}
                className="rounded-lg bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {streaming ? "Asking…" : "Ask"}
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      )}
    </aside>
  );
}