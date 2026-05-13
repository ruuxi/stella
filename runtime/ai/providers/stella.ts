import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
  Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import {
  isRetryableConnectionError,
  retryWithBackoff,
} from "../utils/retry.js";
import { stellaRuntimeUrlFromSiteUrl } from "../../contracts/stella-api.js";

/**
 * Error subclass that preserves the upstream HTTP status (and headers) so
 * `retryWithBackoff` / `isRetryableConnectionError` can classify the
 * failure properly — `new Error(message)` alone strips both and degrades
 * the classifier to message-text matching.
 */
class StellaRuntimeHttpError extends Error {
  readonly status: number;
  readonly headers: Headers;

  constructor(message: string, status: number, headers: Headers) {
    super(message);
    this.name = "StellaRuntimeHttpError";
    this.status = status;
    this.headers = headers;
  }
}

type StreamingToolCall = ToolCall & { partialJson?: string };

type StellaAssistantMessageEvent =
  | { type: "start"; api?: Api; provider?: string; model?: string; responseId?: string }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content?: string; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content?: string; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      usage: Usage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      errorMessage?: string;
      usage: Usage;
    };

function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function buildInitialAssistant(model: Model<"stella">): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    timestamp: Date.now(),
  };
}

const isAuthFailure = (response: Response, body: string): boolean => {
  if (response.status === 401 || response.status === 403) return true;
  return /\b(token expired|expired token|unauthenticated|unauthorized|invalid token)\b/i.test(body);
};

const readStellaErrorMessage = async (response: Response): Promise<string> => {
  let errorMessage = `Stella runtime error: ${response.status} ${response.statusText}`;
  try {
    const text = await response.text();
    if (text.trim()) {
      const trimmed = text.trim();
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object") {
          const record = parsed as { error?: unknown; message?: unknown };
          if (typeof record.error === "string" && record.error.trim()) {
            errorMessage = record.error.trim();
          } else if (
            typeof record.message === "string" &&
            record.message.trim()
          ) {
            errorMessage = record.message.trim();
          } else {
            errorMessage = trimmed;
          }
        } else {
          errorMessage = trimmed;
        }
      } catch {
        errorMessage = trimmed;
      }
    }
  } catch {
    // Ignore body parse failures.
  }
  return errorMessage;
};

function processStellaProxyEvent(
  proxyEvent: StellaAssistantMessageEvent,
  partial: AssistantMessage,
): AssistantMessageEvent | undefined {
  switch (proxyEvent.type) {
    case "start":
      if (proxyEvent.api) {
        partial.api = proxyEvent.api;
      }
      if (proxyEvent.provider) {
        partial.provider = proxyEvent.provider;
      }
      if (proxyEvent.model) {
        partial.model = proxyEvent.model;
      }
      if (proxyEvent.responseId) {
        partial.responseId = proxyEvent.responseId;
      }
      return { type: "start", partial };

    case "text_start":
      partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
      return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

    case "text_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "text") {
        throw new Error("Received text_delta for non-text content");
      }
      content.text += proxyEvent.delta;
      return {
        type: "text_delta",
        contentIndex: proxyEvent.contentIndex,
        delta: proxyEvent.delta,
        partial,
      };
    }

    case "text_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "text") {
        throw new Error("Received text_end for non-text content");
      }
      if (typeof proxyEvent.content === "string") {
        content.text = proxyEvent.content;
      }
      content.textSignature = proxyEvent.contentSignature;
      return {
        type: "text_end",
        contentIndex: proxyEvent.contentIndex,
        content: content.text,
        partial,
      };
    }

    case "thinking_start":
      partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

    case "thinking_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "thinking") {
        throw new Error("Received thinking_delta for non-thinking content");
      }
      content.thinking += proxyEvent.delta;
      return {
        type: "thinking_delta",
        contentIndex: proxyEvent.contentIndex,
        delta: proxyEvent.delta,
        partial,
      };
    }

    case "thinking_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "thinking") {
        throw new Error("Received thinking_end for non-thinking content");
      }
      if (typeof proxyEvent.content === "string" && proxyEvent.content.length > 0) {
        content.thinking = proxyEvent.content;
      }
      content.thinkingSignature = proxyEvent.contentSignature;
      return {
        type: "thinking_end",
        contentIndex: proxyEvent.contentIndex,
        content: content.thinking,
        partial,
      };
    }

    case "toolcall_start": {
      const toolCall: StreamingToolCall = {
        type: "toolCall",
        id: proxyEvent.id,
        name: proxyEvent.toolName,
        arguments: {},
        partialJson: "",
      };
      partial.content[proxyEvent.contentIndex] = toolCall;
      return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
    }

    case "toolcall_delta": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "toolCall") {
        throw new Error("Received toolcall_delta for non-toolCall content");
      }
      const streamingContent = content as StreamingToolCall;
      streamingContent.partialJson = `${streamingContent.partialJson ?? ""}${proxyEvent.delta}`;
      content.arguments = parseStreamingJson<Record<string, unknown>>(streamingContent.partialJson) || {};
      partial.content[proxyEvent.contentIndex] = { ...content };
      return {
        type: "toolcall_delta",
        contentIndex: proxyEvent.contentIndex,
        delta: proxyEvent.delta,
        partial,
      };
    }

    case "toolcall_end": {
      const content = partial.content[proxyEvent.contentIndex];
      if (content?.type !== "toolCall") {
        return undefined;
      }
      delete (content as StreamingToolCall).partialJson;
      return {
        type: "toolcall_end",
        contentIndex: proxyEvent.contentIndex,
        toolCall: content,
        partial,
      };
    }

    case "done":
      partial.stopReason = proxyEvent.reason;
      partial.usage = proxyEvent.usage;
      return { type: "done", reason: proxyEvent.reason, message: partial };

    case "error":
      partial.stopReason = proxyEvent.reason;
      partial.errorMessage = proxyEvent.errorMessage;
      partial.usage = proxyEvent.usage;
      return { type: "error", reason: proxyEvent.reason, error: partial };

    default: {
      const _exhaustiveCheck: never = proxyEvent;
      console.warn("Unhandled Stella event type", _exhaustiveCheck);
      return undefined;
    }
  }
}

function buildRequestPayload(
  model: Model<"stella">,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, unknown> {
  return {
    model: model.id,
    context,
    request: {
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
      reasoning: options?.reasoning,
      extraBody: options?.extraBody,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      metadata: options?.metadata,
      headers: options?.headers,
      maxRetryDelayMs: options?.maxRetryDelayMs,
    },
  };
}

export const streamStella: (
  model: Model<"stella">,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const partial = buildInitialAssistant(model);
    let reader: ReturnType<NonNullable<Response["body"]>["getReader"]> | undefined;

    const abortHandler = () => {
      if (reader) {
        reader.cancel("Request aborted by user").catch(() => {});
      }
    };

    if (options?.signal) {
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const endpoint = stellaRuntimeUrlFromSiteUrl(model.baseUrl);
      let payload = buildRequestPayload(model, context, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== undefined) {
        payload = nextPayload as Record<string, unknown>;
      }

      const request = async (apiKey: string | undefined): Promise<Response> =>
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey || ""}`,
            "Content-Type": "application/json",
            ...model.headers,
            ...options?.headers,
          },
          body: JSON.stringify(payload),
          signal: options?.signal,
        });

      // One-shot auth refresh wrapped around the request. Auth failures
      // are NOT retried via backoff — we refresh the token in-place and
      // either succeed or surface the underlying error to the retry
      // classifier, which rejects 401/403 below.
      const fetchAndValidateResponse = async (): Promise<Response> => {
        let response = await request(options?.apiKey);
        if (response.ok) return response;

        let errorMessage = await readStellaErrorMessage(response);
        if (isAuthFailure(response, errorMessage) && options?.refreshApiKey) {
          const nextApiKey = (await options.refreshApiKey())?.trim();
          if (nextApiKey && nextApiKey !== options.apiKey?.trim()) {
            response = await request(nextApiKey);
            if (response.ok) return response;
            errorMessage = await readStellaErrorMessage(response);
          }
        }

        throw new StellaRuntimeHttpError(
          errorMessage,
          response.status,
          response.headers,
        );
      };

      // Retry transient connection / 5xx / 429 failures at the adapter
      // layer per the workspace retry rule: 3 attempts at a 1s fixed
      // delay, then exponential up to 64s, cap of 10 attempts total.
      // Without this, a single overloaded response from the upstream
      // gateway terminates the entire agent run (fatal=true) and forces
      // the orchestrator to re-spawn from scratch, losing in-flight
      // context. Auth failures are excluded — they're handled by the
      // in-function refresh above and won't recover via backoff.
      const response = await retryWithBackoff(fetchAndValidateResponse, {
        signal: options?.signal,
        isRetryable: (error) => {
          if (error instanceof StellaRuntimeHttpError) {
            if (error.status === 401 || error.status === 403) return false;
          }
          return isRetryableConnectionError(error);
        },
      });

      if (!response.body) {
        throw new Error("Stella runtime returned no response body");
      }

      const streamReader = response.body.getReader();
      reader = streamReader;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        if (options?.signal?.aborted) {
          throw new Error("Request aborted by user");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (line.startsWith(":")) {
            continue;
          }
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          const proxyEvent = JSON.parse(data) as StellaAssistantMessageEvent;
          const event = processStellaProxyEvent(proxyEvent, partial);
          if (event) {
            stream.push(event);
          }
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request aborted by user");
      }

      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const reason = options?.signal?.aborted ? "aborted" : "error";
      partial.stopReason = reason;
      partial.errorMessage = errorMessage;
      stream.push({
        type: "error",
        reason,
        error: partial,
      });
      stream.end();
    } finally {
      if (options?.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
};

export const streamSimpleStella = streamStella;
