import type {
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TextContent,
  ToolCall,
} from "./types";
import { AssistantMessageEventStream } from "./event_stream";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import { transformMessages } from "./transform_messages";
import { sanitizeSurrogates } from "./sanitize_unicode";

type CacheControl = { type: "ephemeral"; ttl?: "1h" };

type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | {
      type: "thinking";
      thinking: string;
      signature: string;
      cache_control?: CacheControl;
    }
  | {
      type: "redacted_thinking";
      data: string;
      cache_control?: CacheControl;
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
      cache_control?: CacheControl;
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | Array<AnthropicContentBlock | AnthropicToolBlock>;
};

type AnthropicToolBlock =
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      cache_control?: CacheControl;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: CacheControl;
    };

type AnthropicSystemBlock = { type: "text"; text: string; cache_control?: CacheControl };

type AnthropicToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  temperature?: number;
  stream: true;
  tools?: AnthropicToolDef[];
  tool_choice?: { type: "auto" | "any" | "none" } | { type: "tool"; name: string };
  thinking?: { type: "enabled"; budget_tokens: number };
};

const EPHEMERAL_CACHE: CacheControl = { type: "ephemeral" };

type AnthropicStreamEvent = {
  type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: {
    type?: string;
    text?: string;
    thinking?: string;
    data?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeAnthropicModelId(modelId: string): string {
  const nativeId = modelId.startsWith("anthropic/") ? modelId.slice("anthropic/".length) : modelId;
  return nativeId.replace(/-(\d+)\.(\d+)$/u, "-$1-$2");
}

function normalizeAnthropicToolUseId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
}

function convertUserContent(content: string | Array<TextContent | ImageContent>): string | AnthropicContentBlock[] {
  if (typeof content === "string") {
    return sanitizeSurrogates(content);
  }
  const hasImages = content.some((block) => block.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(
      content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
    );
  }
  const blocks: AnthropicContentBlock[] = content
    .map((block): AnthropicContentBlock | null => {
      if (block.type === "text") {
        return { type: "text", text: sanitizeSurrogates(block.text) };
      }
      if (!block.data || !block.mimeType) {
        return null;
      }
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      };
    })
    .filter((block): block is AnthropicContentBlock => block !== null);
  if (!blocks.some((block) => block.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}

function anthropicImageBlock(block: ImageContent): AnthropicContentBlock | null {
  if (!block.data || !block.mimeType) {
    return null;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data: block.data,
    },
  };
}

function appendToolResultMessages(messages: AnthropicMessage[], message: Extract<Context["messages"][number], { role: "toolResult" }>): void {
  const text = message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = message.content
    .filter((block): block is ImageContent => block.type === "image")
    .map(anthropicImageBlock)
    .filter((block): block is AnthropicContentBlock => block !== null);

  messages.push({
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: sanitizeSurrogates(text || (images.length > 0 ? "(screenshot attached below)" : "")),
      is_error: message.isError,
    }],
  });

  if (images.length > 0) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: "Screenshot from the preceding computer-use tool result:",
        },
        ...images,
      ],
    });
  }
}

export function convertMessages(model: Model<"anthropic-messages">, context: Context): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const message of transformMessages(context.messages, model, normalizeAnthropicToolUseId)) {
    if (message.role === "system" || message.role === "developer") {
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: convertUserContent(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const content: Array<AnthropicContentBlock | AnthropicToolBlock> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text.trim()) {
            content.push({ type: "text", text: sanitizeSurrogates(block.text) });
          }
          continue;
        }
        if (block.type === "thinking") {
          if (block.redacted) {
            if (block.thinkingSignature?.trim()) {
              content.push({
                type: "redacted_thinking",
                data: block.thinkingSignature,
              });
            }
            continue;
          }
          if (block.thinking.trim()) {
            if (block.thinkingSignature?.trim()) {
              content.push({
                type: "thinking",
                thinking: sanitizeSurrogates(block.thinking),
                signature: block.thinkingSignature,
              });
            } else {
              content.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
            }
          }
          continue;
        }
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        });
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
      continue;
    }
    if (message.role === "toolResult") {
      appendToolResultMessages(messages, message);
    }
  }
  return messages;
}

function reasoningBudget(reasoning: SimpleStreamOptions["reasoning"], maxTokens: number): number | undefined {
  switch (clampReasoning(reasoning)) {
    case "minimal":
      return Math.min(1024, maxTokens - 1);
    case "low":
      return Math.min(2048, maxTokens - 1);
    case "medium":
      return Math.min(4096, maxTokens - 1);
    case "high":
      return Math.min(8192, maxTokens - 1);
    default:
      return undefined;
  }
}

/**
 * Apply prompt-caching breakpoints. Anthropic caches everything before each
 * `cache_control` marker; up to 4 breakpoints per request. Strategy:
 *
 *  1. Mark the last tool definition (caches `system` + tool defs).
 *  2. If there are no tools but a system prompt exists, mark the system block.
 *  3. Mark the last block of the last user/tool_result message (caches the
 *     full conversation history through the most recent turn).
 *
 * This produces a stable cacheable prefix across multi-turn agent runs where
 * tool defs and system prompt don't change, and the only delta turn-to-turn
 * is the new tool result + assistant turn appended at the end.
 */
function applyCacheBreakpoints(body: AnthropicRequestBody): void {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools[body.tools.length - 1].cache_control = EPHEMERAL_CACHE;
  } else if (Array.isArray(body.system) && body.system.length > 0) {
    body.system[body.system.length - 1].cache_control = EPHEMERAL_CACHE;
  }

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      if (message.content.length === 0) continue;
      message.content = [{ type: "text", text: message.content, cache_control: EPHEMERAL_CACHE }];
      return;
    }
    const blocks = message.content;
    if (blocks.length === 0) continue;
    const last = blocks[blocks.length - 1];
    (last as { cache_control?: CacheControl }).cache_control = EPHEMERAL_CACHE;
    return;
  }
}

function buildRequestBody(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
): AnthropicRequestBody {
  const maxTokens = options?.maxTokens ?? Math.min(model.maxTokens, 16_384);
  const budget = reasoningBudget(options?.reasoning, maxTokens);
  const system: AnthropicSystemBlock[] | undefined = context.systemPrompt
    ? [{ type: "text", text: sanitizeSurrogates(context.systemPrompt) }]
    : undefined;
  const body: AnthropicRequestBody = {
    model: normalizeAnthropicModelId(model.id),
    max_tokens: maxTokens,
    messages: convertMessages(model, context),
    system,
    temperature: options?.temperature,
    stream: true,
    tools: context.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    tool_choice: context.tools && context.tools.length > 0 ? { type: "auto" } : undefined,
    thinking: budget && budget > 0 ? { type: "enabled", budget_tokens: budget } : undefined,
  };
  applyCacheBreakpoints(body);
  return body;
}

async function* parseSse(response: Response): AsyncGenerator<AnthropicStreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as AnthropicStreamEvent;
        }
        index = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function mapStopReason(reason?: string): AssistantMessage["stopReason"] {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}

export const streamAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model,
  context,
  options,
) => {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    try {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
      let body = buildRequestBody(model, context, options);
      const nextBody = await options?.onPayload?.(body, model);
      if (nextBody !== undefined) body = nextBody as AnthropicRequestBody;
      const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31,output-128k-2025-02-19",
          "x-api-key": apiKey,
          ...model.headers,
          ...options?.headers,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }

      stream.push({ type: "start", partial: output });
      const toolInputByIndex = new Map<number, string>();
      for await (const event of parseSse(response)) {
        if (event.type === "content_block_start" && event.content_block) {
          if (event.content_block.type === "text") {
            output.content.push({ type: "text", text: event.content_block.text ?? "" });
            stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "thinking") {
            output.content.push({
              type: "thinking",
              thinking: event.content_block.thinking ?? "",
              thinkingSignature: "",
            });
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "redacted_thinking") {
            output.content.push({
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: event.content_block.data,
              redacted: true,
            });
            stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
          } else if (event.content_block.type === "tool_use") {
            output.content.push({
              type: "toolCall",
              id: event.content_block.id ?? `tool_${Date.now()}`,
              name: event.content_block.name ?? "",
              arguments: event.content_block.input ?? {},
            });
            stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
          }
          continue;
        }
        if (event.type === "content_block_delta" && typeof event.index === "number" && event.delta) {
          const block = output.content[event.index];
          if (!block) continue;
          if (block.type === "text" && typeof event.delta.text === "string") {
            block.text += event.delta.text;
            stream.push({ type: "text_delta", contentIndex: event.index, delta: event.delta.text, partial: output });
          } else if (block.type === "thinking" && typeof event.delta.thinking === "string") {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: event.index,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (
            block.type === "thinking"
            && event.delta.type === "signature_delta"
            && typeof event.delta.signature === "string"
          ) {
            block.thinkingSignature = block.thinkingSignature || "";
            block.thinkingSignature += event.delta.signature;
          } else if (block.type === "toolCall" && typeof event.delta.partial_json === "string") {
            const prior = toolInputByIndex.get(event.index) ?? "";
            const next = prior + event.delta.partial_json;
            toolInputByIndex.set(event.index, next);
            try {
              block.arguments = JSON.parse(next) as Record<string, unknown>;
            } catch {
              // Keep streaming partial JSON as deltas; parse when complete.
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: event.index,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
          continue;
        }
        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const block = output.content[event.index];
          if (block?.type === "text") {
            stream.push({ type: "text_end", contentIndex: event.index, content: block.text, partial: output });
          } else if (block?.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: event.index,
              content: block.thinking,
              partial: output,
            });
          } else if (block?.type === "toolCall") {
            const raw = toolInputByIndex.get(event.index);
            if (raw) {
              try {
                block.arguments = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                block.arguments = {};
              }
            }
            stream.push({ type: "toolcall_end", contentIndex: event.index, toolCall: block, partial: output });
          }
          continue;
        }
        if (event.type === "message_delta") {
          output.stopReason = mapStopReason(event.delta?.stop_reason);
          const usage = event.usage;
          if (usage) {
            output.usage.input = usage.input_tokens ?? output.usage.input;
            output.usage.output = usage.output_tokens ?? output.usage.output;
            output.usage.cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead;
            output.usage.cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
            output.usage.totalTokens =
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }
          continue;
        }
        if (event.type === "message_start" && event.message?.usage) {
          output.usage.input = event.message.usage.input_tokens ?? 0;
          output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
          output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
          output.usage.totalTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
        }
      }
      if (output.content.some((block): block is ToolCall => block.type === "toolCall")) {
        output.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
};

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model,
  context,
  options,
) => streamAnthropic(model, context, buildBaseOptions(model, options, options?.apiKey) as SimpleStreamOptions);
