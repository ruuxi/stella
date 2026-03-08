import { createServiceRequest } from "@/infra/http/service-request";
import {
  buildChatHeaders,
  buildChatRequestBody,
  CHAT_COMPLETIONS_PATH,
  extractChatText,
  readChatCompletionStream,
  readChatErrorDetail,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/ai/chat-completions";

export {
  CHAT_COMPLETIONS_PATH,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
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

async function createChatRequest(
  options: ChatRequestBase,
  body: Record<string, unknown>,
): Promise<Response> {
  const { endpoint, headers } = await createServiceRequest(
    options.path ?? CHAT_COMPLETIONS_PATH,
    buildChatHeaders(options),
  );

  return await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  const response = await createChatRequest(
    options,
    buildChatRequestBody({
      model: options.model,
      messages: options.messages,
      stream: false,
      body: options.body,
    }),
  );

  if (!response.ok) {
    const detail = await readChatErrorDetail(response);
    throw new Error(`Chat completion failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as TResponse;
}

export async function streamChatCompletion(
  options: ChatStreamRequest,
): Promise<string> {
  const response = await createChatRequest(
    options,
    buildChatRequestBody({
      model: options.model,
      messages: options.messages,
      stream: true,
      body: options.body,
    }),
  );

  if (!response.ok) {
    const detail = await readChatErrorDetail(response);
    throw new Error(`Chat completion failed (${response.status}): ${detail}`);
  }

  return await readChatCompletionStream(response, options.onChunk);
}
