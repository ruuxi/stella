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

export type ChatRequestOptions = {
  provider: string;
  model: string;
  agentType: string;
  messages: ChatMessage[];
  headers?: Record<string, string>;
};

export function buildChatHeaders(
  options: Pick<ChatRequestOptions, "provider" | "model" | "agentType"> & {
    headers?: Record<string, string>;
  },
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Provider": options.provider,
    "X-Model-Id": options.model,
    "X-Agent-Type": options.agentType,
    ...options.headers,
  };
}

export function buildChatRequestBody(
  options: Pick<ChatRequestOptions, "model" | "messages"> & {
    stream: boolean;
    body?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    ...options.body,
  };
}

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

export async function readChatErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText || "Request failed";
  }
}

export async function readChatCompletionStream(
  response: Response,
  onChunk: (chunk: string) => void,
): Promise<string> {
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
        onChunk(delta);
      } catch {
        // Ignore malformed SSE chunks from upstream providers.
      }
    }
  }

  return fullContent;
}
