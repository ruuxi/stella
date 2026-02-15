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
  onAbort?: () => void;
};

type StreamOptions = {
  signal?: AbortSignal;
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

const isAbortError = (error: unknown, signal?: AbortSignal) => {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
};

export const streamChat = async (
  payload: ChatRequest,
  handlers: StreamHandlers = {},
  options: StreamOptions = {},
) => {
  const baseUrl = import.meta.env.VITE_CONVEX_URL;
  if (!baseUrl) {
    throw new Error("VITE_CONVEX_URL is not set.");
  }

  if (options.signal?.aborted) {
    handlers.onAbort?.();
    return;
  }

  const httpBaseUrl =
    import.meta.env.VITE_CONVEX_HTTP_URL ??
    baseUrl.replace(".convex.cloud", ".convex.site");

  const endpoint = new URL("/api/chat", httpBaseUrl).toString();
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      credentials: "include",
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      handlers.onAbort?.();
      return;
    }
    handlers.onError?.(error as Error);
    throw error;
  }

  if (!response.ok) {
    const error = new Error(`Chat gateway error: ${response.status}`);
    handlers.onError?.(error);
    throw error;
  }

  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const doneState = { done: false };

  try {
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
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      handlers.onAbort?.();
      return;
    }
    handlers.onError?.(error as Error);
    throw error;
  }

  if (!doneState.done) {
    handlers.onDone?.();
  }
};
