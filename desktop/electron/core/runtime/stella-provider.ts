import { completeSimple, streamSimple } from "../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
} from "../ai/types.js";
import {
  extractChatText,
  normalizeStellaApiBaseUrl,
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
  STELLA_MODELS_PATH,
  type ChatCompletionResponse,
  type ChatMessage,
} from "../../../src/shared/stella-api.js";

function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export {
  extractChatText,
  normalizeStellaApiBaseUrl,
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
  STELLA_MODELS_PATH,
};
export type { ChatCompletionResponse, ChatMessage };

export type StellaChatRequestOptions = {
  agentType: string;
  messages: ChatMessage[];
  model?: string;
  headers?: Record<string, string>;
};

export type StellaTransport = {
  endpoint: string;
  headers?: Record<string, string>;
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

const toTextBlocks = (content: ChatMessage["content"]): TextContent[] => {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  return content
    .filter((part): part is { type?: string; text: string } => typeof part?.text === "string")
    .map((part) => ({ type: "text" as const, text: part.text.trim() }))
    .filter((part) => part.text.length > 0);
};

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function buildStellaChatContext(messages: ChatMessage[]): Context {
  const systemParts: string[] = [];
  const llmMessages: Context["messages"] = [];

  for (const message of messages) {
    const blocks = toTextBlocks(message.content);
    if (message.role === "system" || message.role === "developer") {
      const text = blocks.map((b) => b.text).join("\n").trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (blocks.length === 0) continue;

    if (message.role === "user") {
      llmMessages.push({ role: "user", content: blocks, timestamp: Date.now() });
      continue;
    }

    llmMessages.push({
      role: "assistant",
      content: blocks,
      timestamp: Date.now(),
      stopReason: "stop",
      usage: emptyUsage(),
      api: "openai-completions",
      provider: "stella",
      model: STELLA_DEFAULT_MODEL,
    });
  }

  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages: llmMessages,
  };
}

function buildModel(
  endpoint: string,
  agentType: string,
  modelId: string,
  extraHeaders?: Record<string, string>,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId === STELLA_DEFAULT_MODEL ? "Stella Recommended" : modelId.replace(/^stella\//, ""),
    api: "openai-completions",
    provider: "stella",
    baseUrl: normalizeStellaApiBaseUrl(endpoint),
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 16_384,
    headers: {
      "X-Stella-Agent-Type": agentType,
      ...extraHeaders,
    },
    compat: {
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_completion_tokens",
      supportsStrictMode: false,
    },
  };
}

type CompletionExecution = {
  model: Model<"openai-completions">;
  context: Context;
  options: SimpleStreamOptions;
};

const createCompletion = (args: {
  transport: StellaTransport;
  request: StellaChatRequestOptions;
  body?: Record<string, unknown>;
}): CompletionExecution => ({
  model: buildModel(
    args.transport.endpoint,
    args.request.agentType,
    args.request.model ?? STELLA_DEFAULT_MODEL,
    {
      ...args.transport.headers,
      ...args.request.headers,
    },
  ),
  context: buildStellaChatContext(args.request.messages),
  options: toSimpleOptions(args.body),
});

const ensureSuccess = (message: AssistantMessage): AssistantMessage => {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || "Chat completion failed");
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

export async function callStellaChatCompletion<TResponse = ChatCompletionResponse>(args: {
  transport: StellaTransport;
  request: StellaChatRequestOptions;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<TResponse> {
  const execution = createCompletion(args);
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

export async function streamStellaChatCompletion(args: {
  transport: StellaTransport;
  request: StellaChatRequestOptions;
  body?: Record<string, unknown>;
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const execution = createCompletion(args);
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
