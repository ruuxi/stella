import { getAuthToken } from "./auth-token";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "orchestrator" | "general" | "self_mod";
};

type StreamHandlers = {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onStart?: () => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
};

type UiStreamEvent = {
  type?: string;
  text?: string;
  delta?: string;
};

const handleUiEvent = (
  event: UiStreamEvent,
  handlers: StreamHandlers,
  state: { done: boolean },
) => {
  if (event.type === "text-start") {
    handlers.onStart?.();
  }
  if (event.type === "text-delta") {
    const delta = event.text ?? event.delta ?? "";
    if (delta) {
      handlers.onTextDelta?.(delta);
    }
  }
  // Handle reasoning events from AI SDK
  if (event.type === "reasoning-delta") {
    const delta = event.text ?? event.delta ?? "";
    if (delta) {
      handlers.onReasoningDelta?.(delta);
    }
  }
  if (event.type === "text-end" || event.type === "finish") {
    if (!state.done) {
      state.done = true;
      handlers.onDone?.();
    }
  }
};

export const streamChat = async (payload: ChatRequest, handlers: StreamHandlers = {}) => {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) {
    throw new Error("VITE_CONVEX_URL is not set.");
  }

  const token = await getAuthToken();

  const httpBaseUrl =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

  const endpoint = new URL("/api/chat", httpBaseUrl).toString();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Chat gateway error: ${response.status}`);
  }

  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const doneState = { done: false };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payloadText = trimmed.slice(5).trim();
        if (!payloadText) {
          continue;
        }
        if (payloadText === "[DONE]") {
          if (!doneState.done) {
            doneState.done = true;
            handlers.onDone?.();
          }
          continue;
        }
        try {
          const event = JSON.parse(payloadText) as UiStreamEvent;
          handleUiEvent(event, handlers, doneState);
        } catch (error) {
          handlers.onError?.(error as Error);
        }
      }
    }
  }

  if (!doneState.done) {
    handlers.onDone?.();
  }
};
