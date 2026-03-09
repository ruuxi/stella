import { createServiceRequest } from "@/infra/http/service-request";
import {
  callManagedChatCompletion,
  CHAT_COMPLETIONS_PATH,
  extractChatText,
  streamManagedChatCompletion,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@stella/stella-runtime";

export {
  CHAT_COMPLETIONS_PATH,
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
    options.path ?? CHAT_COMPLETIONS_PATH,
    options.headers,
  );
}

export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  return await callManagedChatCompletion<TResponse>({
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
  return await streamManagedChatCompletion({
    transport: await createManagedTransport(options),
    request: {
      agentType: options.agentType,
      messages: options.messages,
    },
    body: options.body,
    onChunk: options.onChunk,
  });
}
