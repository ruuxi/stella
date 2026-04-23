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
