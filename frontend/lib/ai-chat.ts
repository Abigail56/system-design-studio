/**
 * Streaming chat transport.
 *
 * Uses `fetch` rather than `EventSource`: the API authenticates with a Clerk
 * bearer token in the `Authorization` header, and `EventSource` cannot send
 * headers. So the stream is read and parsed by hand.
 */

import { apiBaseUrl, ApiError } from "@/lib/api-client";

export type ChatRole = "user" | "assistant";

export type ChatTurn = {
  role: ChatRole;
  content: string;
};

export type ModelResponse = {
  model: string;
  content: string;
  error?: string;
  done: boolean;
};

export type PanelTurn = ChatTurn & {
  responses?: ModelResponse[];
};

export type AiModel = {
  id: string;
  name: string;
};

export type StreamEvent =
  | { type: "delta"; model: string; text: string }
  | { type: "model_done"; model: string }
  | { type: "model_error"; model: string; error: string }
  | { type: "done" }
  | { type: "error"; error: string };

type StreamOptions = {
  projectId: string;
  message: string;
  history: ChatTurn[];
  models: string[];
  token: string;
  signal?: AbortSignal;
  onDelta: (model: string, text: string) => void;
  onModelDone: (model: string) => void;
  onModelError: (model: string, error: string) => void;
};

/**
 * Posts a message and invokes `onDelta` per chunk as it arrives.
 *
 * Throws only when the request could not be started or the response was not
 * OK. Once the stream is open, a mid-stream failure arrives as an `error`
 * event, because the status line has already been sent by then.
 */
export async function streamChat({
  projectId,
  message,
  history,
  models,
  token,
  signal,
  onDelta,
  onModelDone,
  onModelError,
}: StreamOptions): Promise<void> {
  const url = `${apiBaseUrl()}/v1/ai/chat`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ project_id: projectId, message, history, models }),
    signal,
  });

  if (!response.ok || !response.body) {
    let detail = `Chat failed (${response.status})`;
    try {
      const body = await response.json();
      detail = body?.error ?? body?.detail ?? detail;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(detail, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // SSE frames are separated by a blank line. A chunk can split mid-frame, so
  // the partial tail is carried over rather than parsed early.
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      const dataLine = frame
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      try {
        const event = JSON.parse(dataLine.slice(5).trim()) as StreamEvent;
        if (event.type === "delta") onDelta(event.model, event.text);
        if (event.type === "model_done") onModelDone(event.model);
        if (event.type === "model_error") onModelError(event.model, event.error);
        if (event.type === "error") throw new ApiError(event.error, 502);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // A malformed frame is not worth killing the stream over.
      }
    }
  }
}