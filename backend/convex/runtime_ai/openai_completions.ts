import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { AssistantMessageEventStream } from "./event_stream";
import { parseStreamingJson } from "./json_parse";
import { calculateCost, supportsXhigh } from "./model_utils";
import { sanitizeSurrogates } from "./sanitize_unicode";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import { transformMessages } from "./transform_messages";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "./types";

function normalizeMistralToolId(id: string): string {
  let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (normalized.length < 9) {
    normalized = normalized + "ABCDEFGHI".slice(0, 9 - normalized.length);
  } else if (normalized.length > 9) {
    normalized = normalized.slice(0, 9);
  }
  return normalized;
}

export function hasToolHistory(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.role === "toolResult") {
      return true;
    }
    if (
      message.role === "assistant"
      && message.content.some((block) => block.type === "toolCall")
    ) {
      return true;
    }
  }
  return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  responseFormat?: unknown;
}

type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_text";
type ReasoningDetail = { type?: string; id?: string; data?: string };
type CompletionDeltaWithReasoning = NonNullable<ChatCompletionChunk.Choice["delta"]>
  & Partial<Record<ReasoningField, string | null>>
  & { reasoning_details?: ReasoningDetail[] };
type AssistantMessageWithExtras = ChatCompletionAssistantMessageParam
  & Partial<Record<ReasoningField, string>>
  & { reasoning_details?: ReasoningDetail[] };
type ToolResultMessageWithName = ChatCompletionToolMessageParam & { name?: string };
type OpenAIErrorWithMetadata = { error?: { metadata?: { raw?: string } } };

function toChatCompletionImagePart(
  item: { type: "image"; url?: string; mimeType?: string; data?: string; detail?: "auto" | "low" | "high" },
): ChatCompletionContentPartImage | null {
  const url = item.url || (
    item.mimeType && item.data ? `data:${item.mimeType};base64,${item.data}` : null
  );
  if (!url) {
    return null;
  }
  return {
    type: "image_url",
    image_url: {
      url,
      ...(item.detail ? { detail: item.detail } : {}),
    },
  } satisfies ChatCompletionContentPartImage;
}

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const client = createClient(model, options?.apiKey, options?.headers);
      let params = buildOpenAICompletionsParams(model, context, options, true);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }

      const openaiStream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        options?.signal ? { signal: options.signal } : undefined,
      );
      stream.push({ type: "start", partial: output });

      let currentBlock:
        | TextContent
        | ThinkingContent
        | (ToolCall & { partialArgs?: string })
        | null = null;

      const finishCurrentBlock = (block: typeof currentBlock) => {
        if (!block) {
          return;
        }
        const contentIndex = output.content.length - 1;
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.text,
            partial: output,
          });
          return;
        }
        if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
          return;
        }
        block.arguments = parseStreamingJson(block.partialArgs);
        delete block.partialArgs;
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: block,
          partial: output,
        });
      };

      for await (const chunk of openaiStream) {
        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
          const input = chunk.usage.prompt_tokens || 0;
          const outputTokens = chunk.usage.completion_tokens || 0;
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
          output.usage = {
            input,
            output: outputTokens,
            cacheRead: cachedTokens,
            cacheWrite: 0,
            reasoningTokens,
            totalTokens: input + outputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, output.usage);
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }
        if (choice.finish_reason) {
          output.stopReason = mapStopReason(choice.finish_reason);
        }
        if (!choice.delta) {
          continue;
        }

        const deltaWithReasoning = choice.delta as CompletionDeltaWithReasoning;
        if (typeof choice.delta.content === "string" && choice.delta.content.length > 0) {
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.text += choice.delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta: choice.delta.content,
            partial: output,
          });
        }

        const reasoningFields: ReasoningField[] = [
          "reasoning_content",
          "reasoning",
          "reasoning_text",
        ];
        let reasoningField: ReasoningField | undefined;
        for (const field of reasoningFields) {
          const value = deltaWithReasoning[field];
          if (typeof value === "string" && value.length > 0) {
            reasoningField = field;
            break;
          }
        }

        if (reasoningField) {
          const delta = deltaWithReasoning[reasoningField] || "";
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: reasoningField,
            };
            output.content.push(currentBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: output.content.length - 1,
            delta,
            partial: output,
          });
        }

        if (choice.delta.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            if (
              !currentBlock
              || currentBlock.type !== "toolCall"
              || (toolCall.id && currentBlock.id !== toolCall.id)
            ) {
              finishCurrentBlock(currentBlock);
              currentBlock = {
                type: "toolCall",
                id: toolCall.id || "",
                name: toolCall.function?.name || "",
                arguments: {},
                partialArgs: "",
              };
              output.content.push(currentBlock);
              stream.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }

            if (toolCall.id) {
              currentBlock.id = toolCall.id;
            }
            if (toolCall.function?.name) {
              currentBlock.name = toolCall.function.name;
            }

            const delta = toolCall.function?.arguments || "";
            if (delta) {
              currentBlock.partialArgs = (currentBlock.partialArgs || "") + delta;
              currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: output.content.length - 1,
              delta,
              partial: output,
            });
          }
        }

        if (deltaWithReasoning.reasoning_details) {
          for (const detail of deltaWithReasoning.reasoning_details) {
            if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
              const matchingToolCall = output.content.find(
                (block) => block.type === "toolCall" && block.id === detail.id,
              );
              if (matchingToolCall?.type === "toolCall") {
                matchingToolCall.thoughtSignature = JSON.stringify(detail);
              }
            }
          }
        }
      }

      finishCurrentBlock(currentBlock);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      const rawMetadata = (error as OpenAIErrorWithMetadata | null)?.error?.metadata?.raw;
      if (rawMetadata) {
        output.errorMessage += `\n${rawMetadata}`;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (model, context, options) => {
  const base = buildBaseOptions(model, options, options?.apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;
  const responseFormat = (options as OpenAICompletionsOptions | undefined)?.responseFormat;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
    responseFormat,
  });
};

function createClient(
  model: Model<"openai-completions">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    defaultHeaders: {
      ...model.headers,
      ...optionsHeaders,
    },
  });
}

export function buildOpenAICompletionsParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  stream = true,
) {
  const compat = getCompat(model);
  const messages = convertMessages(model, context, compat);
  maybeAddOpenRouterAnthropicCacheControl(model, messages);

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    stream,
    ...(options?.extraBody ?? {}),
  };

  if (stream && compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    params[compat.maxTokensField] = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  if (options?.responseFormat !== undefined) {
    params.response_format = options.responseFormat;
  }

  if ((compat.thinkingFormat === "zai" || compat.thinkingFormat === "qwen") && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
    params.reasoning_effort = options.reasoningEffort;
  }

  if (model.baseUrl.includes("openrouter.ai") && model.compat?.openRouterRouting) {
    params.provider = model.compat.openRouterRouting;
  }

  if (
    model.baseUrl.includes("ai-gateway.vercel.sh")
    && model.compat?.vercelGatewayRouting
  ) {
    const gatewayOptions: Record<string, string[]> = {};
    if (model.compat.vercelGatewayRouting.only) {
      gatewayOptions.only = model.compat.vercelGatewayRouting.only;
    }
    if (model.compat.vercelGatewayRouting.order) {
      gatewayOptions.order = model.compat.vercelGatewayRouting.order;
    }
    if (Object.keys(gatewayOptions).length > 0) {
      params.providerOptions = { gateway: gatewayOptions };
    }
  }

  return params;
}

function maybeAddOpenRouterAnthropicCacheControl(
  model: Model<"openai-completions">,
  messages: ChatCompletionMessageParam[],
) {
  if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string") {
      message.content = [
        Object.assign(
          { type: "text" as const, text: message.content },
          { cache_control: { type: "ephemeral" } },
        ),
      ];
      return;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (part?.type === "text") {
        Object.assign(part, { cache_control: { type: "ephemeral" } });
        return;
      }
    }
  }
}

export function convertMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  compat: Required<OpenAICompletionsCompat>,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    if (compat.requiresMistralToolIds) {
      return normalizeMistralToolId(id);
    }
    if (id.includes("|")) {
      const [callId] = id.split("|");
      return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    }
    return model.provider === "openai" && id.length > 40 ? id.slice(0, 40) : id;
  };

  const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

  if (context.systemPrompt) {
    params.push({
      role: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let lastRole: string | null = null;
  for (let index = 0; index < transformedMessages.length; index += 1) {
    const message = transformedMessages[index];

    if (
      compat.requiresAssistantAfterToolResult
      && lastRole === "toolResult"
      && message.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (message.role === "user") {
      if (typeof message.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(message.content),
        });
      } else {
        const content: ChatCompletionContentPart[] = message.content.map(
          (item): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            return toChatCompletionImagePart(item) as ChatCompletionContentPartImage;
          },
        ).filter(Boolean);
        const filtered = model.input.includes("image")
          ? content
          : content.filter((part) => part.type !== "image_url");
        if (filtered.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content: filtered,
        });
      }
      lastRole = message.role;
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      params.push({
        role:
          message.role === "developer" && !(model.reasoning && compat.supportsDeveloperRole)
            ? "system"
            : message.role,
        content: sanitizeSurrogates(message.content),
      });
      lastRole = message.role;
      continue;
    }

    if (message.role === "assistant") {
      const assistantMessage: AssistantMessageWithExtras = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const textBlocks = message.content.filter(
        (block): block is TextContent =>
          block.type === "text" && block.text.trim().length > 0,
      );
      if (textBlocks.length > 0) {
        assistantMessage.content = textBlocks
          .map((block) => sanitizeSurrogates(block.text))
          .join("");
      }

      const thinkingBlocks = message.content.filter(
        (block): block is ThinkingContent =>
          block.type === "thinking" && block.thinking.trim().length > 0,
      );
      if (thinkingBlocks.length > 0 && !compat.requiresThinkingAsText) {
        const signature = thinkingBlocks[0].thinkingSignature;
        if (signature) {
          assistantMessage[signature as ReasoningField] = thinkingBlocks
            .map((block) => block.thinking)
            .join("\n");
        }
      }

      const toolCalls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
        const reasoningDetails = toolCalls
          .filter((toolCall) => toolCall.thoughtSignature)
          .map((toolCall) => {
            try {
              return JSON.parse(toolCall.thoughtSignature!);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        if (reasoningDetails.length > 0) {
          assistantMessage.reasoning_details = reasoningDetails;
        }
      }

      const hasContent =
        assistantMessage.content !== null
        && assistantMessage.content !== undefined
        && (typeof assistantMessage.content === "string"
          ? assistantMessage.content.length > 0
          : assistantMessage.content.length > 0);
      if (!hasContent && !assistantMessage.tool_calls) {
        continue;
      }

      params.push(assistantMessage);
      lastRole = message.role;
      continue;
    }

    const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
    let nextIndex = index;
    for (
      ;
      nextIndex < transformedMessages.length
      && transformedMessages[nextIndex].role === "toolResult";
      nextIndex += 1
    ) {
      const toolMessage = transformedMessages[nextIndex] as ToolResultMessage;
      const textResult = toolMessage.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const toolResult: ToolResultMessageWithName = {
        role: "tool",
        content: sanitizeSurrogates(textResult || "(see attached image)"),
        tool_call_id: toolMessage.toolCallId,
      };
      if (compat.requiresToolResultName && toolMessage.toolName) {
        toolResult.name = toolMessage.toolName;
      }
      params.push(toolResult);

      if (model.input.includes("image")) {
        for (const block of toolMessage.content) {
          if (block.type === "image") {
            imageBlocks.push({
              type: "image_url",
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
      }
    }

    index = nextIndex - 1;
    if (imageBlocks.length > 0) {
      if (compat.requiresAssistantAfterToolResult) {
        params.push({
          role: "assistant",
          content: "I have processed the tool results.",
        });
      }
      params.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          ...imageBlocks,
        ],
      });
      lastRole = "user";
      continue;
    }

    lastRole = "toolResult";
  }

  return params;
}

export function convertTools(
  tools: Tool[],
  compat: Required<OpenAICompletionsCompat>,
) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode !== false && tool.strict !== undefined
        ? { strict: tool.strict }
        : {}),
    },
  }));
}

export function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): StopReason {
  switch (reason) {
    case null:
    case "stop":
    case "end":
      return "stop";
    case "length":
      return "length";
    case "function_call":
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "stop";
    default:
      return "error";
  }
}

function detectCompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");
  const isNonStandard =
    provider === "cerebras"
    || baseUrl.includes("cerebras.ai")
    || provider === "xai"
    || baseUrl.includes("api.x.ai")
    || isMistral
    || baseUrl.includes("chutes.ai")
    || baseUrl.includes("deepseek.com")
    || isZai
    || provider === "opencode"
    || baseUrl.includes("opencode.ai");

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: provider !== "xai" && !isZai,
    supportsUsageInStreaming: true,
    maxTokensField:
      isMistral || baseUrl.includes("chutes.ai")
        ? "max_tokens"
        : "max_completion_tokens",
    requiresToolResultName: isMistral,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isMistral,
    requiresMistralToolIds: isMistral,
    thinkingFormat: isZai ? "zai" : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: true,
  };
}

function getCompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const detected = detectCompat(model);
  if (!model.compat) {
    return detected;
  }
  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole:
      model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName:
      model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult
      ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText:
      model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresMistralToolIds:
      model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: model.compat.openRouterRouting ?? detected.openRouterRouting,
    vercelGatewayRouting:
      model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    supportsStrictMode:
      model.compat.supportsStrictMode ?? detected.supportsStrictMode,
  };
}
