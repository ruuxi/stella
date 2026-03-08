import { createServiceRequest } from "@/infra/http/service-request";

export const CHAT_COMPLETIONS_PATH = "/api/ai/v1/chat/completions";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer";
  content: string | Array<{ type?: string; text?: string }>;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    delta?: {
      content?: string;
    };
  }>;
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
  };
};

type ChatRequestBase = {
  provider: string;
  model: string;
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

export function extractChatText(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function createChatRequest(
  options: ChatRequestBase,
  body: Record<string, unknown>,
): Promise<Response> {
  const { endpoint, headers } = await createServiceRequest(
    options.path ?? CHAT_COMPLETIONS_PATH,
    {
      "Content-Type": "application/json",
      "X-Provider": options.provider,
      "X-Model-Id": options.model,
      "X-Agent-Type": options.agentType,
      ...options.headers,
    },
  );

  return await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText || "Request failed";
  }
}

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  const response = await createChatRequest(options, {
    model: options.model,
    messages: options.messages,
    stream: false,
    ...options.body,
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`Chat completion failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as TResponse;
}

export async function streamChatCompletion(
  options: ChatStreamRequest,
): Promise<string> {
  const response = await createChatRequest(options, {
    model: options.model,
    messages: options.messages,
    stream: true,
    ...options.body,
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`Chat completion failed (${response.status}): ${detail}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Chat completion returned no response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data) as ChatCompletionResponse;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (!delta) continue;
        fullContent += delta;
        options.onChunk(delta);
      } catch {
        // Ignore malformed SSE chunks from upstream providers.
      }
    }
  }

  return fullContent;
}
