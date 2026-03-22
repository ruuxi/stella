import { createServiceRequest } from "@/infra/http/service-request";
import {
  STELLA_CHAT_COMPLETIONS_PATH,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/stella-api";

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

async function createManagedTransport(
  options: ChatRequestBase,
) {
  return await createServiceRequest(
    options.path ?? STELLA_CHAT_COMPLETIONS_PATH,
    options.headers,
  );
}

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  const request = await createManagedTransport({
    ...options,
    headers: {
      ...options.headers,
      "X-Stella-Agent-Type": options.agentType,
    },
  });

  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...request.headers,
    },
    body: JSON.stringify({
      ...options.body,
      messages: options.messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`Chat completion failed with HTTP ${response.status}`);
  }

  return (await response.json()) as TResponse;
}

export async function streamChatCompletion(
  options: ChatStreamRequest,
): Promise<string> {
  const request = await createManagedTransport({
    ...options,
    headers: {
      ...options.headers,
      "X-Stella-Agent-Type": options.agentType,
    },
  });

  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...request.headers,
    },
    body: JSON.stringify({
      ...options.body,
      messages: options.messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Streaming chat failed with HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Streaming chat response body was empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let finalMessageText = "";

  const flushLine = (line: string) => {
    if (!line.startsWith("data:")) {
      return;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }

    const chunk = JSON.parse(payload) as ChatCompletionResponse;
    const extractedText = extractChatText(chunk);
    if (extractedText) {
      finalMessageText = extractedText;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (!delta) {
      return;
    }

    fullText += delta;
    options.onChunk(delta);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let lineBreakIndex = buffer.indexOf("\n");
    while (lineBreakIndex !== -1) {
      const line = buffer.slice(0, lineBreakIndex).trim();
      buffer = buffer.slice(lineBreakIndex + 1);
      if (line) {
        flushLine(line);
      }
      lineBreakIndex = buffer.indexOf("\n");
    }

    if (done) {
      const trailingLine = buffer.trim();
      if (trailingLine) {
        flushLine(trailingLine);
      }
      break;
    }
  }

  return fullText || finalMessageText;
}
