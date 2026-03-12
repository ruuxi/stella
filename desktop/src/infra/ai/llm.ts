import { createServiceRequest } from "@/infra/http/service-request";
import {
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/ai/stella";

export {
  STELLA_CHAT_COMPLETIONS_PATH,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
};

type ChatRequestBase = {
  agentType: string;
  messages: ChatMessage[];
  path?: string;
  headers?: Record<string, string>;
};

type ChatJsonRequest = ChatRequestBase & {
  body?: Record<string, unknown>;
};

type ChatStreamRequest = ChatRequestBase & {
  body?: Record<string, unknown>;
  onChunk: (chunk: string) => void;
};

type ManagedTransport = Awaited<ReturnType<typeof createServiceRequest>>;

type OpenAICompatibleChatCompletionChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
    };
  }>;
};

type ErrorPayload = {
  error?: {
    message?: string;
  };
};

async function createManagedTransport(
  options: ChatRequestBase,
): Promise<ManagedTransport> {
  return await createServiceRequest(
    options.path ?? STELLA_CHAT_COMPLETIONS_PATH,
    {
      "X-Stella-Agent-Type": options.agentType,
      ...options.headers,
    },
  );
}

function createRequestBody(
  messages: ChatMessage[],
  body: Record<string, unknown> | undefined,
  stream: boolean,
) {
  const payload: Record<string, unknown> = {
    ...body,
    model:
      typeof body?.model === "string" && body.model.trim()
        ? body.model
        : STELLA_DEFAULT_MODEL,
    messages,
    stream,
  };

  if (stream && payload.stream_options === undefined) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}

async function ensureOkResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }

  let message = `HTTP ${response.status}`;
  try {
    const raw = await response.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ErrorPayload;
        message = parsed.error?.message?.trim() || raw.trim() || message;
      } catch {
        message = raw.trim() || message;
      }
    }
  } catch {
    // Ignore response body parse failures and fall back to status text.
  }

  throw new Error(message);
}

async function createChatRequest(
  transport: ManagedTransport,
  body: Record<string, unknown>,
  accept: string,
) {
  return await ensureOkResponse(
    await fetch(transport.endpoint, {
      method: "POST",
      headers: {
        Accept: accept,
        "Content-Type": "application/json",
        ...transport.headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

function readStreamDelta(chunk: OpenAICompatibleChatCompletionChunk): string {
  const delta = chunk.choices?.[0]?.delta?.content;
  return typeof delta === "string" ? delta : "";
}

function processSseLine(
  line: string,
  onChunk: (chunk: string) => void,
  state: { fullContent: string },
) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }

  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") {
    return;
  }

  let parsed: OpenAICompatibleChatCompletionChunk;
  try {
    parsed = JSON.parse(data) as OpenAICompatibleChatCompletionChunk;
  } catch {
    return;
  }

  const delta = readStreamDelta(parsed);
  if (!delta) {
    return;
  }

  state.fullContent += delta;
  onChunk(delta);
}

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  const transport = await createManagedTransport(options);
  const response = await createChatRequest(
    transport,
    createRequestBody(options.messages, options.body, false),
    "application/json",
  );
  return (await response.json()) as TResponse;
}

export async function streamChatCompletion(
  options: ChatStreamRequest,
): Promise<string> {
  const transport = await createManagedTransport(options);
  const response = await createChatRequest(
    transport,
    createRequestBody(options.messages, options.body, true),
    "text/event-stream",
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Chat completion returned no response body");
  }

  const decoder = new TextDecoder();
  const state = { fullContent: "" };
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processSseLine(line, options.onChunk, state);
    }
  }

  if (buffer) {
    processSseLine(buffer, options.onChunk, state);
  }

  return state.fullContent;
}
