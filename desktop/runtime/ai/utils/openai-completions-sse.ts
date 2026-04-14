import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  StopReason,
  ToolCall,
  Usage,
} from "../types.js";
import { parseStreamingJson } from "./json-parse.js";

export type OpenAICompatibleChatCompletionChunk = {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  choices?: Array<{
    finish_reason?: "stop" | "length" | "function_call" | "tool_calls" | "content_filter" | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_text?: string | null;
      reasoning_signature?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
};

type StreamingToolCall = ToolCall & { partialArgs?: string };

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function createAssistantMessageShell(
  model: Pick<Model<Api>, "api" | "provider" | "id">,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      ...EMPTY_USAGE,
      cost: { ...EMPTY_USAGE.cost },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function mapStopReason(
  reason: "stop" | "length" | "function_call" | "tool_calls" | "content_filter" | null | undefined,
): StopReason {
  if (reason === null || reason === undefined) return "stop";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "function_call":
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "error";
  }
}

function updateUsage(
  output: AssistantMessage,
  usage: OpenAICompatibleChatCompletionChunk["usage"] | undefined,
): void {
  if (!usage) return;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const input = (usage.prompt_tokens || 0) - cachedTokens;
  const outputTokens = usage.completion_tokens || 0;
  output.usage = {
    input,
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens:
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : input + outputTokens + cachedTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function updateResolvedModel(output: AssistantMessage, modelId: string | undefined): void {
  const trimmed = modelId?.trim();
  if (!trimmed) return;
  output.model = trimmed;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0) {
    output.provider = trimmed.slice(0, slashIndex);
  }
}

export async function pumpOpenAICompatibleChatCompletionsResponse(args: {
  response: Response;
  stream: AssistantMessageEventStream;
  output: AssistantMessage;
  signal?: AbortSignal;
}): Promise<void> {
  const reader = args.response.body?.getReader();
  if (!reader) {
    throw new Error("Chat completion returned no response body");
  }

  args.stream.push({ type: "start", partial: args.output });

  const decoder = new TextDecoder();
  let buffer = "";
  let currentBlock: AssistantMessage["content"][number] | StreamingToolCall | null = null;
  const blocks = args.output.content;
  const blockIndex = () => blocks.length - 1;

  const finishCurrentBlock = (block?: typeof currentBlock) => {
    if (!block) return;
    if (block.type === "text") {
      args.stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: block.text,
        partial: args.output,
      });
      return;
    }
    if (block.type === "thinking") {
      args.stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: block.thinking,
        partial: args.output,
      });
      return;
    }
    if (block.type === "toolCall") {
      const streamingBlock = block as StreamingToolCall;
      streamingBlock.arguments = parseStreamingJson(streamingBlock.partialArgs);
      delete streamingBlock.partialArgs;
      args.stream.push({
        type: "toolcall_end",
        contentIndex: blockIndex(),
        toolCall: streamingBlock,
        partial: args.output,
      });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (args.signal?.aborted) {
      throw new Error("Request aborted by user");
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let chunk: OpenAICompatibleChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as OpenAICompatibleChatCompletionChunk;
      } catch {
        continue;
      }

      updateResolvedModel(args.output, chunk.model);
      updateUsage(args.output, chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason !== undefined) {
        args.output.stopReason = mapStopReason(choice.finish_reason);
      }

      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!currentBlock || currentBlock.type !== "text") {
          finishCurrentBlock(currentBlock);
          currentBlock = { type: "text", text: "" };
          blocks.push(currentBlock);
          args.stream.push({ type: "text_start", contentIndex: blockIndex(), partial: args.output });
        }
        if (currentBlock.type === "text") {
          currentBlock.text += delta.content;
          args.stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: delta.content,
            partial: args.output,
          });
        }
      }

      const reasoningDelta =
        (typeof delta.reasoning_content === "string" && delta.reasoning_content)
        || (typeof delta.reasoning === "string" && delta.reasoning)
        || (typeof delta.reasoning_text === "string" && delta.reasoning_text)
        || "";

      if (reasoningDelta) {
        if (!currentBlock || currentBlock.type !== "thinking") {
          finishCurrentBlock(currentBlock);
          currentBlock = { type: "thinking", thinking: "" };
          blocks.push(currentBlock);
          args.stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: args.output });
        }
        if (currentBlock.type === "thinking") {
          currentBlock.thinking += reasoningDelta;
          args.stream.push({
            type: "thinking_delta",
            contentIndex: blockIndex(),
            delta: reasoningDelta,
            partial: args.output,
          });
        }
      }

      if (typeof delta.reasoning_signature === "string" && delta.reasoning_signature.length > 0) {
        if (currentBlock?.type === "thinking") {
          currentBlock.thinkingSignature = delta.reasoning_signature;
        } else {
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index];
            if (block?.type === "thinking") {
              block.thinkingSignature = delta.reasoning_signature;
              break;
            }
          }
        }
      }

      for (const toolCallDelta of delta.tool_calls ?? []) {
        const targetIndex = typeof toolCallDelta.index === "number" ? toolCallDelta.index : 0;
        const existingBlock = blocks[targetIndex];
        if (!existingBlock || existingBlock.type !== "toolCall") {
          finishCurrentBlock(currentBlock);
          const toolCall: StreamingToolCall = {
            type: "toolCall",
            id: toolCallDelta.id || crypto.randomUUID(),
            name: toolCallDelta.function?.name || "",
            arguments: {},
            partialArgs: "",
          };
          blocks[targetIndex] = toolCall;
          currentBlock = toolCall;
          args.stream.push({ type: "toolcall_start", contentIndex: targetIndex, partial: args.output });
        } else {
          currentBlock = existingBlock as StreamingToolCall;
        }

        if (currentBlock.type !== "toolCall") {
          continue;
        }

        const streamingBlock = currentBlock as StreamingToolCall;
        if (toolCallDelta.id) {
          streamingBlock.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          streamingBlock.name = toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          streamingBlock.partialArgs = `${streamingBlock.partialArgs || ""}${toolCallDelta.function.arguments}`;
          args.stream.push({
            type: "toolcall_delta",
            contentIndex: targetIndex,
            delta: toolCallDelta.function.arguments,
            partial: args.output,
          });
        }
      }
    }
  }

  finishCurrentBlock(currentBlock);

  if (args.output.stopReason === "error" || args.output.stopReason === "aborted") {
    args.stream.push({
      type: "error",
      reason: args.output.stopReason,
      error: args.output,
    });
    return;
  }

  args.stream.push({
    type: "done",
    reason:
      args.output.stopReason === "toolUse"
        ? "toolUse"
        : args.output.stopReason === "length"
          ? "length"
          : "stop",
    message: args.output,
  });
}
