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
import { headersToRecord } from "./headers";
import { parseStreamingJson } from "./json_parse";
import { supportsXhigh } from "./model_utils";
import { sanitizeSurrogates } from "./sanitize_unicode";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import { transformMessages } from "./transform_messages";
import { parseOpenAIChatUsage, type OpenAIChatUsagePayload } from "./usage";
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
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall")
    ) {
      return true;
    }
  }
  return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } }
    | { type: "function"; name: string };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  responseFormat?: unknown;
}

function normalizeChatToolChoice(
  toolChoice: OpenAICompletionsOptions["toolChoice"],
):
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice;
  }
  const record = toolChoice as Record<string, unknown>;
  const nested = record.function as Record<string, unknown> | undefined;
  const nestedName =
    nested && typeof nested.name === "string" ? nested.name : "";
  if (nestedName.length > 0) {
    return { type: "function", function: { name: nestedName } };
  }
  const directName = typeof record.name === "string" ? record.name : "";
  if (directName.length > 0) {
    return { type: "function", function: { name: directName } };
  }
  return undefined;
}

type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_text";
type ReasoningDetail = { type?: string; id?: string; data?: string };
type CompletionDeltaWithReasoning = NonNullable<
  ChatCompletionChunk.Choice["delta"]
> &
  Partial<Record<ReasoningField, string | null>> & {
    reasoning_details?: ReasoningDetail[];
  };
type AssistantMessageWithExtras = ChatCompletionAssistantMessageParam &
  Partial<Record<ReasoningField, string>> & {
    reasoning_details?: ReasoningDetail[];
  };
type ToolResultMessageWithName = ChatCompletionToolMessageParam & {
  name?: string;
};
type OpenAIErrorWithMetadata = { error?: { metadata?: { raw?: string } } };

function toChatCompletionImagePart(item: {
  type: "image";
  url?: string;
  mimeType?: string;
  data?: string;
  detail?: "auto" | "low" | "high";
}): ChatCompletionContentPartImage | null {
  const url =
    item.url ||
    (item.mimeType && item.data
      ? `data:${item.mimeType};base64,${item.data}`
      : null);
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
      const compat = getCompat(model);
      const cacheSessionId =
        options?.cacheRetention === "none" ? undefined : options?.sessionId;
      const client = createClient(
        model,
        options?.apiKey,
        options?.headers,
        cacheSessionId,
        compat,
      );
      let params = buildOpenAICompletionsParams(model, context, options, true);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }

      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        ...(options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
      };
      const { data: openaiStream, response } = await client.chat.completions
        .create(
          params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          requestOptions,
        )
        .withResponse();
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      type StreamingToolCallBlock = ToolCall & {
        partialArgs?: string;
        streamIndex?: number;
      };

      let currentBlock:
        | TextContent
        | ThinkingContent
        | StreamingToolCallBlock
        | null = null;

      const finishCurrentBlock = (block: typeof currentBlock) => {
        if (!block) {
          return;
        }
        const contentIndex = output.content.indexOf(block);
        if (contentIndex === -1) {
          return;
        }
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
        if (!chunk || typeof chunk !== "object") continue;

        // OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
        // and each chunk in a streamed completion carries the same id.
        output.responseId ||= chunk.id;
        if (
          typeof chunk.model === "string" &&
          chunk.model.length > 0 &&
          chunk.model !== model.id
        ) {
          output.responseModel ||= chunk.model;
        }

        if (chunk.usage) {
          output.usage = parseOpenAIChatUsage(chunk.usage, model);
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }

        // Fallback: some providers (e.g., Moonshot) return usage in choice.usage
        if (!chunk.usage && "usage" in choice && choice.usage) {
          output.usage = parseOpenAIChatUsage(
            choice.usage as OpenAIChatUsagePayload,
            model,
          );
        }

        if (choice.finish_reason) {
          const finishReasonResult = mapStopReasonDetailed(
            choice.finish_reason,
          );
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
        }
        if (!choice.delta) {
          continue;
        }

        const deltaWithReasoning = choice.delta as CompletionDeltaWithReasoning;
        if (
          typeof choice.delta.content === "string" &&
          choice.delta.content.length > 0
        ) {
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
            const streamIndex =
              typeof toolCall.index === "number" ? toolCall.index : undefined;
            if (
              !currentBlock ||
              currentBlock.type !== "toolCall" ||
              (streamIndex !== undefined &&
                currentBlock.streamIndex !== streamIndex) ||
              (streamIndex === undefined &&
                toolCall.id &&
                currentBlock.id !== toolCall.id)
            ) {
              finishCurrentBlock(currentBlock);
              currentBlock = {
                type: "toolCall",
                id: toolCall.id || "",
                name: toolCall.function?.name || "",
                arguments: {},
                partialArgs: "",
                streamIndex,
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
              currentBlock.partialArgs =
                (currentBlock.partialArgs || "") + delta;
              currentBlock.arguments = parseStreamingJson(
                currentBlock.partialArgs,
              );
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
            if (
              detail.type === "reasoning.encrypted" &&
              detail.id &&
              detail.data
            ) {
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
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(
          output.errorMessage || "Provider returned an error stop reason",
        );
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      const rawMetadata = (error as OpenAIErrorWithMetadata | null)?.error
        ?.metadata?.raw;
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
  const toolChoice = (options as OpenAICompletionsOptions | undefined)
    ?.toolChoice;
  const responseFormat = (options as OpenAICompletionsOptions | undefined)
    ?.responseFormat;

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
  sessionId?: string,
  compat: Required<OpenAICompletionsCompat> = getCompat(model),
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const defaultHeaders: Record<string, string> = {
    ...model.headers,
  };
  if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
    defaultHeaders["HTTP-Referer"] ??= "https://stella.sh";
    defaultHeaders["X-OpenRouter-Title"] ??= "Stella";
  }
  Object.assign(defaultHeaders, optionsHeaders);
  if (sessionId && compat.sendSessionAffinityHeaders) {
    defaultHeaders.session_id = sessionId;
    defaultHeaders["x-client-request-id"] = sessionId;
    defaultHeaders["x-session-affinity"] = sessionId;
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    maxRetries: 0,
    defaultHeaders,
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

  // Help upstream providers route requests to the same cache shard.
  // OpenAI Chat Completions, Fireworks, OpenRouter (where the underlying
  // provider supports it) all honor `prompt_cache_key`. Harmless to send
  // when ignored. Skip when caller explicitly opts out via cacheRetention.
  if (
    options?.sessionId &&
    options.sessionId.length > 0 &&
    (options as { cacheRetention?: string }).cacheRetention !== "none" &&
    params.prompt_cache_key === undefined
  ) {
    params.prompt_cache_key = options.sessionId;
  }
  if (
    options?.cacheRetention === "long" &&
    compat.supportsLongCacheRetention &&
    params.prompt_cache_retention === undefined
  ) {
    params.prompt_cache_retention = "24h";
  }

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
    if (compat.zaiToolStream) {
      params.tool_stream = true;
    }
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  const toolChoice = normalizeChatToolChoice(options?.toolChoice);
  if (toolChoice) {
    params.tool_choice = toolChoice;
  }
  if (options?.responseFormat !== undefined) {
    params.response_format = options.responseFormat;
  }

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (
    compat.thinkingFormat === "qwen-chat-template" &&
    model.reasoning
  ) {
    params.chat_template_kwargs = {
      enable_thinking: !!options?.reasoningEffort,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = {
      type: options?.reasoningEffort ? "enabled" : "disabled",
    };
    if (options?.reasoningEffort) {
      params.reasoning_effort = mapReasoningEffort(
        options.reasoningEffort,
        compat.reasoningEffortMap,
      );
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    if (options?.reasoningEffort) {
      params.reasoning = {
        effort: mapReasoningEffort(
          options.reasoningEffort,
          compat.reasoningEffortMap,
        ),
      };
    } else {
      params.reasoning = { effort: "none" };
    }
  } else if (
    options?.reasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort
  ) {
    params.reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
  }

  if (
    model.baseUrl.includes("openrouter.ai") &&
    model.compat?.openRouterRouting
  ) {
    params.provider = model.compat.openRouterRouting;
  }

  if (
    model.baseUrl.includes("ai-gateway.vercel.sh") &&
    model.compat?.vercelGatewayRouting
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

function mapReasoningEffort(
  effort: NonNullable<OpenAICompletionsOptions["reasoningEffort"]>,
  reasoningEffortMap: Partial<
    Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string>
  >,
): string {
  return reasoningEffortMap[effort] ?? effort;
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
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
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

  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

  if (context.systemPrompt) {
    params.push({
      role:
        model.reasoning && compat.supportsDeveloperRole
          ? "developer"
          : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let lastRole: string | null = null;
  for (let index = 0; index < transformedMessages.length; index += 1) {
    const message = transformedMessages[index];

    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      message.role === "user"
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
        const content: ChatCompletionContentPart[] = message.content
          .map((item): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            return toChatCompletionImagePart(
              item,
            ) as ChatCompletionContentPartImage;
          })
          .filter(Boolean);
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
          message.role === "developer" &&
          !(model.reasoning && compat.supportsDeveloperRole)
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
        assistantMessage.content !== null &&
        assistantMessage.content !== undefined &&
        (typeof assistantMessage.content === "string"
          ? assistantMessage.content.length > 0
          : assistantMessage.content.length > 0);
      if (!hasContent && !assistantMessage.tool_calls) {
        continue;
      }

      params.push(assistantMessage);
      lastRole = message.role;
      continue;
    }

    const imageBlocks: Array<{
      type: "image_url";
      image_url: { url: string };
    }> = [];
    let nextIndex = index;
    for (
      ;
      nextIndex < transformedMessages.length &&
      transformedMessages[nextIndex].role === "toolResult";
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

export function mapStopReason(
  reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): StopReason {
  return mapStopReasonDetailed(reason).stopReason;
}

function mapStopReasonDetailed(
  reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): { stopReason: StopReason; errorMessage?: string } {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return {
        stopReason: "error",
        errorMessage: "Provider finish_reason: content_filter",
      };
    case "network_error":
      return {
        stopReason: "error",
        errorMessage: "Provider finish_reason: network_error",
      };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
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
    provider === "cerebras" ||
    baseUrl.includes("cerebras.ai") ||
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    isMistral ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    provider === "opencode" ||
    baseUrl.includes("opencode.ai");

  const isGroq = provider === "groq" || baseUrl.includes("groq.com");
  const reasoningEffortMap =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: provider !== "xai" && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField:
      isMistral || baseUrl.includes("chutes.ai")
        ? "max_tokens"
        : "max_completion_tokens",
    requiresToolResultName: isMistral,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isMistral,
    requiresMistralToolIds: isMistral,
    thinkingFormat: isZai
      ? "zai"
      : provider === "deepseek" || baseUrl.includes("deepseek.com")
        ? "deepseek"
        : provider === "openrouter" || baseUrl.includes("openrouter.ai")
          ? "openrouter"
          : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode: true,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: false,
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
    reasoningEffortMap:
      model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ??
      detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName:
      model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ??
      detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText:
      model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresMistralToolIds:
      model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting:
      model.compat.openRouterRouting ?? detected.openRouterRouting,
    vercelGatewayRouting:
      model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
    supportsStrictMode:
      model.compat.supportsStrictMode ?? detected.supportsStrictMode,
    sendSessionAffinityHeaders:
      model.compat.sendSessionAffinityHeaders ??
      detected.sendSessionAffinityHeaders,
    supportsLongCacheRetention:
      model.compat.supportsLongCacheRetention ??
      detected.supportsLongCacheRetention,
  };
}
