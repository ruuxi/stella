import { createServiceRequest } from "@/infra/http/service-request";
import {
  callStellaChatCompletion,
  STELLA_CHAT_COMPLETIONS_PATH,
  extractChatText,
  streamStellaChatCompletion,
  type ChatCompletionResponse,
  type ChatMessage,
} from "../../../electron/core/runtime/stella-provider.js";

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
  return await callStellaChatCompletion<TResponse>({
    transport: await createManagedTransport(options),
    request: {
      agentType: options.agentType,
      messages: options.messages,
    },
    body: options.body,
  });
}

export async function streamChatCompletion(
  options: ChatStreamRequest,
): Promise<string> {
  return await streamStellaChatCompletion({
    transport: await createManagedTransport(options),
    request: {
      agentType: options.agentType,
      messages: options.messages,
    },
    body: options.body,
    onChunk: options.onChunk,
  });
}
