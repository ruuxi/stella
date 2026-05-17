import { postServiceJson } from "@/infra/http/service-request";
import {
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/stella-api";

export { extractChatText };

type ChatRequestBase = {
  agentType: string;
  messages: ChatMessage[];
  path?: string;
  headers?: Record<string, string>;
};

type ChatJsonRequest = ChatRequestBase & {
  body?: Record<string, unknown>;
};

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  return await postServiceJson<TResponse>(
    options.path ?? STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
    {
      ...options.body,
      messages: options.messages,
    },
    {
      headers: {
        ...options.headers,
        "X-Stella-Agent-Type": options.agentType,
      },
      errorMessage: (response) =>
        `Chat completion failed with HTTP ${response.status}`,
    },
  );
}
