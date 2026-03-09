import {
  completeSimple,
  createManagedContext,
  createManagedModel,
  readAssistantText,
  streamSimple,
  type AssistantMessage,
  type ManagedChatMessage,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@stella/stella-ai";

export const CHAT_COMPLETIONS_PATH = "/api/managed-ai/chat/completions";

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
  agentType: string;
  messages: ChatMessage[];
  headers?: Record<string, string>;
};

export type ManagedChatTransport = {
  endpoint: string;
  headers?: Record<string, string>;
};

type ManagedCompletionOptions = {
  model: ReturnType<typeof createManagedModel>;
  context: ReturnType<typeof createManagedContext>;
  options: SimpleStreamOptions;
};

const toSimpleOptions = (
  body?: Record<string, unknown>,
): SimpleStreamOptions => {
  const maxTokensValue = body?.max_completion_tokens ?? body?.max_tokens;
  const reasoningValue = body?.reasoning_effort;
  return {
    maxTokens: typeof maxTokensValue === "number" ? maxTokensValue : undefined,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    reasoning:
      reasoningValue === "minimal" || reasoningValue === "low" || reasoningValue === "medium" || reasoningValue === "high" || reasoningValue === "xhigh"
        ? reasoningValue as ThinkingLevel
        : undefined,
  };
};

const createManagedCompletion = (args: {
  transport: ManagedChatTransport;
  request: ChatRequestOptions;
  body?: Record<string, unknown>;
}): ManagedCompletionOptions => ({
  model: createManagedModel({
    endpoint: args.transport.endpoint,
    agentType: args.request.agentType,
    headers: {
      ...args.transport.headers,
      ...args.request.headers,
    },
  }),
  context: createManagedContext(args.request.messages as ManagedChatMessage[]),
  options: toSimpleOptions(args.body),
});

const ensureSuccess = (message: AssistantMessage): AssistantMessage => {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "Managed chat completion failed");
  }
  return message;
};

const messageToResponse = (message: AssistantMessage): ChatCompletionResponse => ({
  choices: [{
    message: {
      content: message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
    },
  }],
  usage: {
    input_tokens: message.usage.input,
    prompt_tokens: message.usage.input + message.usage.cacheRead,
    output_tokens: message.usage.output,
    completion_tokens: message.usage.output,
  },
});

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

export async function callManagedChatCompletion<TResponse = ChatCompletionResponse>(args: {
  transport: ManagedChatTransport;
  request: ChatRequestOptions;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<TResponse> {
  const execution = createManagedCompletion(args);
  const message = ensureSuccess(await completeSimple(
    execution.model,
    execution.context,
    {
      ...execution.options,
      signal: args.signal,
    },
  ));
  return messageToResponse(message) as TResponse;
}

export async function streamManagedChatCompletion(args: {
  transport: ManagedChatTransport;
  request: ChatRequestOptions;
  body?: Record<string, unknown>;
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const execution = createManagedCompletion(args);
  const stream = streamSimple(
    execution.model,
    execution.context,
    {
      ...execution.options,
      signal: args.signal,
    },
  );

  let fullContent = "";
  for await (const event of stream) {
    if (event.type !== "text_delta") {
      continue;
    }
    fullContent += event.delta;
    args.onChunk(event.delta);
  }

  const finalMessage = ensureSuccess(await stream.result());
  return fullContent || readAssistantText(finalMessage);
}
