import { completeSimple, streamSimple } from "../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
  ToolCall,
} from "../ai/types.js";
import {
  extractChatText,
  normalizeStellaApiBaseUrl,
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_DEFAULT_MODEL,
  STELLA_MODELS_PATH,
  type ChatCompletionResponse,
  type ChatMessage,
  type ChatToolCall,
} from "../../src/shared/stella-api.js";

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
  const thinkingValue = body?.thinking;
  return {
    maxTokens: typeof maxTokensValue === "number" ? maxTokensValue : undefined,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    reasoning:
      reasoningValue === "minimal" || reasoningValue === "low" || reasoningValue === "medium" || reasoningValue === "high" || reasoningValue === "xhigh"
        ? reasoningValue as ThinkingLevel
        : undefined,
    ...(thinkingValue !== undefined
      ? {
          onPayload: (payload: unknown) => {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
              return undefined;
            }
            return {
              ...(payload as Record<string, unknown>),
              thinking: thinkingValue,
            };
          },
        }
      : {}),
  };
};

const toTextBlocks = (content: ChatMessage["content"]): TextContent[] => {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (
        part,
      ): part is Extract<ChatMessage["content"], readonly unknown[]>[number] & {
        text: string;
      } => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string",
    )
    .map((part) => ({ type: "text" as const, text: part.text.trim() }))
    .filter((part) => part.text.length > 0);
};

const reasoningFields = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const;

const toReasoningBlocks = (
  message: ChatMessage,
): AssistantMessage["content"] => {
  for (const field of reasoningFields) {
    const value = message[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    return [{
      type: "thinking",
      thinking: value.trim(),
      thinkingSignature: field,
    }];
  }
  return [];
};

const toToolCalls = (toolCalls: ChatToolCall[] | undefined): ToolCall[] =>
  (toolCalls ?? []).flatMap((toolCall) => {
    const id = typeof toolCall.id === "string" ? toolCall.id : "";
    const name = typeof toolCall.function?.name === "string"
      ? toolCall.function.name
      : "";
    const rawArguments = typeof toolCall.function?.arguments === "string"
      ? toolCall.function.arguments
      : "{}";
    if (!id || !name) {
      return [];
    }
    try {
      return [{
        type: "toolCall" as const,
        id,
        name,
        arguments: JSON.parse(rawArguments) as Record<string, unknown>,
      }];
    } catch {
      return [{
        type: "toolCall" as const,
        id,
        name,
        arguments: {},
      }];
    }
  });

const emptyUsage = (): AssistantMessage["usage"] => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function buildStellaChatContext(messages: ChatMessage[]): Context {
  const systemParts: string[] = [];
  const llmMessages: Context["messages"] = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    const blocks = toTextBlocks(message.content);
    if (message.role === "system" || message.role === "developer") {
      const text = blocks.map((b) => b.text).join("\n").trim();
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === "user") {
      if (blocks.length === 0) continue;
      llmMessages.push({ role: "user", content: blocks, timestamp: Date.now() });
      continue;
    }

    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      llmMessages.push({
        role: "toolResult",
        toolCallId: message.tool_call_id,
        toolName:
          typeof message.name === "string" && message.name.trim().length > 0
            ? message.name
            : (toolNameById.get(message.tool_call_id) ?? ""),
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    const toolCalls = toToolCalls(message.tool_calls);
    for (const toolCall of toolCalls) {
      toolNameById.set(toolCall.id, toolCall.name);
    }
    const content = [
      ...toReasoningBlocks(message),
      ...blocks,
      ...toolCalls,
    ];
    if (content.length === 0) continue;

    llmMessages.push({
      role: "assistant",
      content,
      timestamp: Date.now(),
      stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
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

const readAssistantReasoning = (message: AssistantMessage): string | undefined => {
  const reasoning = message.content
    .filter(
      (part): part is Extract<AssistantMessage["content"][number], { type: "thinking" }> =>
        part.type === "thinking",
    )
    .map((part) => part.thinking)
    .join("\n")
    .trim();
  return reasoning.length > 0 ? reasoning : undefined;
};

const messageToResponse = (message: AssistantMessage): ChatCompletionResponse => {
  const reasoningContent = readAssistantReasoning(message);
  return ({
  choices: [{
    message: {
      role: "assistant",
      content: message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => ({ type: "text", text: part.text })),
      ...(reasoningContent
        ? { reasoning_content: reasoningContent }
        : {}),
      ...(message.content.some((part) => part.type === "toolCall")
        ? {
            tool_calls: message.content
              .filter(
                (part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
                  part.type === "toolCall",
              )
              .map((part) => ({
                id: part.id,
                type: "function" as const,
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.arguments),
                },
              })),
          }
        : {}),
    },
  }],
  usage: {
    input_tokens: message.usage.input,
    prompt_tokens: message.usage.input + message.usage.cacheRead,
    output_tokens: message.usage.output,
    completion_tokens: message.usage.output,
  },
  });
};

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
