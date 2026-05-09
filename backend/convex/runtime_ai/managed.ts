import OpenAI from "openai";
import {
  resolveManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import {
  buildOpenAICompletionsParams,
  mapStopReason,
} from "./openai_completions";
import {
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  isRetryableProviderError,
  retryDelayMs,
  retryProviderRequest,
} from "./retry";
import { completeSimple, streamSimple } from "./stream";
import { parseOpenAIChatUsage } from "./usage";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
  Tool,
  ToolCall,
} from "./types";
export {
  usageSummaryFromAssistant,
  type ManagedUsageSummary,
} from "../lib/managed_usage";

export type ManagedProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ManagedModelConfig = {
  model: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Input modalities the upstream model actually supports. Resolved at the
   * request entry point from `billing_model_prices` (synced from
   * models.dev). When omitted, `buildManagedModel` defaults to ["text"]
   * so unknown models drop image/audio/video/pdf at the gateway boundary
   * (`transformMessages` swaps unsupported parts for text placeholders)
   * instead of forwarding multi-megabyte data URLs that some providers
   * tokenize as raw character streams.
   */
  modalitiesInput?: ("text" | "image" | "audio" | "video" | "pdf")[];
};

type ManagedCompletionRequest = {
  temperature?: number;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  toolChoice?: ManagedToolChoice;
  responseFormat?: unknown;
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  sessionId?: string;
  cacheRetention?: "none" | "short" | "long";
};

type OpenAIChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

type ManagedToolChoice =
  | OpenAIChatToolChoice
  | { type: "function"; name: string };

type ChatRequestMessage = {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
  reasoning_text?: unknown;
  reasoning_signature?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
};

type ChatCompletionReasoningField =
  | "reasoning_content"
  | "reasoning"
  | "reasoning_text";

type ChatCompletionReasoningDetail = {
  type?: unknown;
  id?: unknown;
  data?: unknown;
};

function normalizeImageDetail(
  value: unknown,
): ImageContent["detail"] | undefined {
  return value === "auto" || value === "low" || value === "high"
    ? value
    : undefined;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function normalizeReasoning(value: unknown): ThinkingLevel | undefined {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function readReasoningText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => readReasoningText(entry))
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      );
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ["text", "thinking", "summary", "content"];
  const parts = preferredKeys
    .map((key) => readReasoningText(record[key]))
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function providerFromBaseUrl(baseUrl: string): string {
  if (baseUrl.includes("openrouter.ai")) {
    return "openrouter";
  }
  if (baseUrl.includes("api.fireworks.ai")) {
    return "fireworks";
  }
  if (baseUrl.includes("ai-gateway.vercel.sh")) {
    return "vercel-ai-gateway";
  }
  if (baseUrl.includes("api.openai.com")) {
    return "openai";
  }
  if (baseUrl.includes("api.anthropic.com")) {
    return "anthropic";
  }
  if (baseUrl.includes("generativelanguage.googleapis.com")) {
    return "google";
  }
  return "managed";
}

function modelIdForGateway(model: string, provider: string): string {
  if (provider === "openai" && model.startsWith("openai/")) {
    return model.slice("openai/".length);
  }
  return model;
}

function resolveManagedProtocol(args: {
  api?: ManagedProtocol;
  config: ManagedModelConfig;
}): ManagedProtocol {
  if (args.api) {
    return args.api;
  }
  const gateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  if (gateway.provider === "fireworks" || gateway.provider === "openai") {
    return "openai-responses";
  }
  if (gateway.provider === "anthropic") {
    return "anthropic-messages";
  }
  if (gateway.provider === "google") {
    return "google-generative-ai";
  }
  return "openai-completions";
}

function inferCompat(
  config: ManagedModelConfig,
  provider: string,
): OpenAICompletionsCompat {
  const gatewayRouting = config.providerOptions?.gateway;
  const compat: OpenAICompletionsCompat = {
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_completion_tokens",
    supportsStrictMode: true,
  };

  if (provider === "vercel-ai-gateway" && gatewayRouting) {
    compat.vercelGatewayRouting = {
      only: asStringArray(gatewayRouting.only),
      order: asStringArray(gatewayRouting.order),
    };
  }
  if (provider === "openrouter" && gatewayRouting) {
    compat.openRouterRouting = {
      only: asStringArray(gatewayRouting.only),
      order: asStringArray(gatewayRouting.order),
    };
  }
  return compat;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const filtered = value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  return filtered.length > 0 ? filtered : undefined;
}

function readTextContent(content: unknown): Array<TextContent | ImageContent> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (
      (record.type === "text" ||
        record.type === "input_text" ||
        record.type === "output_text") &&
      typeof record.text === "string"
    ) {
      if (record.text.length > 0) {
        blocks.push({ type: "text", text: record.text });
      }
      continue;
    }

    if (record.type === "image_url" || record.type === "input_image") {
      const imageRecord =
        record.image_url && typeof record.image_url === "object"
          ? (record.image_url as Record<string, unknown>)
          : null;
      const imageUrl =
        typeof record.image_url === "string"
          ? record.image_url
          : imageRecord && typeof imageRecord.url === "string"
            ? imageRecord.url
            : typeof record.url === "string"
              ? record.url
              : null;
      if (!imageUrl) {
        continue;
      }

      const detail = normalizeImageDetail(imageRecord?.detail ?? record.detail);
      if (imageUrl.startsWith("data:")) {
        const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
          continue;
        }
        blocks.push({
          type: "image",
          mimeType: match[1],
          data: match[2],
          detail,
        });
        continue;
      }

      blocks.push({
        type: "image",
        url: imageUrl,
        detail,
      });
    }
  }

  return blocks;
}

function readAssistantTextBlocks(content: unknown): TextContent[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: TextContent[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (
      (record.type === "text" || record.type === "output_text") &&
      typeof record.text === "string" &&
      record.text.length > 0
    ) {
      blocks.push({ type: "text", text: record.text });
      continue;
    }
    if (Array.isArray(record.content)) {
      blocks.push(...readAssistantTextBlocks(record.content));
    }
  }
  return blocks;
}

function readAssistantToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const toolCalls: ToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    const id = typeof record.id === "string" ? record.id : "";
    const name =
      functionRecord && typeof functionRecord.name === "string"
        ? functionRecord.name
        : "";
    const rawArguments =
      functionRecord && typeof functionRecord.arguments === "string"
        ? functionRecord.arguments
        : "{}";
    if (!id || !name) {
      continue;
    }

    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      parsedArguments = {};
    }

    toolCalls.push({
      type: "toolCall",
      id,
      name,
      arguments: parsedArguments,
    });
  }
  return toolCalls;
}

function readAssistantReasoningBlocks(
  message: ChatRequestMessage,
): AssistantMessage["content"] {
  const reasoningFields: ChatCompletionReasoningField[] = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ];
  for (const field of reasoningFields) {
    const thinking = readReasoningText(message[field]);
    if (!thinking) {
      continue;
    }
    return [
      {
        type: "thinking",
        thinking,
        thinkingSignature:
          typeof message.reasoning_signature === "string" &&
          message.reasoning_signature.trim().length > 0
            ? message.reasoning_signature.trim()
            : field,
      },
    ];
  }
  return [];
}

function readTools(value: unknown): Tool[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tools: Tool[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const functionRecord =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    if (!functionRecord) {
      continue;
    }
    const name =
      typeof functionRecord.name === "string" ? functionRecord.name : "";
    if (!name) {
      continue;
    }
    tools.push({
      name,
      description:
        typeof functionRecord.description === "string"
          ? functionRecord.description
          : "",
      parameters:
        functionRecord.parameters &&
        typeof functionRecord.parameters === "object"
          ? (functionRecord.parameters as Record<string, unknown>)
          : { type: "object", properties: {} },
      strict: functionRecord.strict === true,
    });
  }

  return tools.length > 0 ? tools : undefined;
}

/**
 * Derives the `Model.input` modality set from the resolved
 * `ManagedModelConfig.modalitiesInput`. Stella's `Model.input` only
 * tracks "text" and "image" today (audio/video/pdf are not natively
 * supported on the runtime side), so we narrow models.dev's broader
 * modality list to that subset. Defaults to ["text"] when modalities
 * are unknown so unknown models drop image data URLs at the gateway
 * boundary instead of being forwarded to a provider that may tokenize
 * the data URL as raw characters.
 */
function resolveModelInput(
  modalitiesInput: ManagedModelConfig["modalitiesInput"],
): ("text" | "image")[] {
  if (!modalitiesInput || modalitiesInput.length === 0) {
    return ["text"];
  }
  const supportsImage = modalitiesInput.includes("image");
  return supportsImage ? ["text", "image"] : ["text"];
}

export function buildManagedModel<TApi extends Api>(
  config: ManagedModelConfig,
  api: TApi,
  headers?: Record<string, string>,
): Model<TApi> {
  const managedGateway = resolveManagedGatewayConfig({
    model: config.model,
    configuredProvider: config.managedGatewayProvider,
  });
  const provider = providerFromBaseUrl(managedGateway.baseURL);
  const modelId = modelIdForGateway(config.model, provider);
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: managedGateway.baseURL,
    reasoning: true,
    input: resolveModelInput(config.modalitiesInput),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: config.maxOutputTokens ?? 16_384,
    headers,
    compat:
      api === "openai-completions"
        ? (inferCompat(config, provider) as Model<TApi>["compat"])
        : undefined,
  };
}

export function buildContextFromChatMessages(
  messages: unknown,
  tools?: unknown,
): Context {
  const systemParts: string[] = [];
  const runtimeMessages: Context["messages"] = [];

  if (Array.isArray(messages)) {
    for (const message of messages as ChatRequestMessage[]) {
      const role = typeof message.role === "string" ? message.role : "";
      const blocks = readTextContent(message.content);
      if (role === "system" || role === "developer") {
        const text = blocks
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (text) {
          runtimeMessages.push({
            role,
            content: text,
            timestamp: Date.now(),
          });
        }
        continue;
      }

      if (role === "user") {
        if (blocks.length > 0) {
          runtimeMessages.push({
            role: "user",
            content: blocks,
            timestamp: Date.now(),
          });
        }
        continue;
      }

      if (role === "assistant") {
        const content = [
          ...readAssistantReasoningBlocks(message),
          ...blocks.filter(
            (block): block is TextContent => block.type === "text",
          ),
          ...readAssistantToolCalls(message.tool_calls),
        ];
        if (content.length > 0) {
          runtimeMessages.push({
            role: "assistant",
            content,
            timestamp: Date.now(),
            stopReason: content.some((block) => block.type === "toolCall")
              ? "toolUse"
              : "stop",
            usage: emptyUsage(),
            api: "openai-completions",
            provider: "managed",
            model: "stella",
          });
        }
        continue;
      }

      if (role === "tool" && typeof message.tool_call_id === "string") {
        runtimeMessages.push({
          role: "toolResult",
          toolCallId: message.tool_call_id,
          toolName: typeof message.name === "string" ? message.name : "",
          content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
  }

  return {
    ...(systemParts.length > 0
      ? { systemPrompt: systemParts.join("\n\n") }
      : {}),
    messages: runtimeMessages,
    ...(readTools(tools) ? { tools: readTools(tools) } : {}),
  };
}

function buildSimpleOptions(args: {
  config: ManagedModelConfig;
  request?: ManagedCompletionRequest;
}): SimpleStreamOptions & {
  toolChoice?: ManagedToolChoice;
  responseFormat?: unknown;
  extraBody?: Record<string, unknown>;
} {
  const reasoning =
    args.request?.reasoning ??
    normalizeReasoning(args.config.providerOptions?.openai?.reasoningEffort) ??
    (args.config.providerOptions?.openai?.forceReasoning
      ? "high"
      : undefined);

  const managedGateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  const extraBody: Record<string, unknown> = {
    ...(args.request?.extraBody ?? {}),
  };
  const gatewayRouting = args.config.providerOptions?.gateway;

  if (
    managedGateway.baseURL.includes("openrouter.ai") &&
    gatewayRouting &&
    extraBody.provider === undefined
  ) {
    extraBody.provider = gatewayRouting;
  }

  if (
    managedGateway.baseURL.includes("ai-gateway.vercel.sh") &&
    gatewayRouting &&
    extraBody.providerOptions === undefined
  ) {
    extraBody.providerOptions = { gateway: gatewayRouting };
  }

  if (
    args.request?.toolChoice !== undefined &&
    extraBody.tool_choice === undefined
  ) {
    extraBody.tool_choice = args.request.toolChoice;
  }

  if (
    args.request?.responseFormat !== undefined &&
    extraBody.response_format === undefined
  ) {
    extraBody.response_format = args.request.responseFormat;
  }

  return {
    temperature: args.request?.temperature ?? args.config.temperature,
    maxTokens: args.request?.maxTokens ?? args.config.maxOutputTokens,
    reasoning,
    toolChoice: args.request?.toolChoice,
    responseFormat: args.request?.responseFormat,
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    signal: args.request?.signal,
    apiKey: process.env[managedGateway.apiKeyEnvVar]?.trim(),
    headers: args.request?.headers,
    sessionId: args.request?.sessionId,
    cacheRetention: args.request?.cacheRetention,
  };
}

async function completeManagedOpenAICompletions(args: {
  config: ManagedModelConfig;
  context: Context;
  request?: ManagedCompletionRequest;
}): Promise<AssistantMessage> {
  const managedGateway = resolveManagedGatewayConfig({
    model: args.config.model,
    configuredProvider: args.config.managedGatewayProvider,
  });
  const apiKey = process.env[managedGateway.apiKeyEnvVar]?.trim();
  if (!apiKey) {
    throw new Error(`Missing ${managedGateway.apiKeyEnvVar}`);
  }

  const model = buildManagedModel(
    args.config,
    "openai-completions",
    args.request?.headers,
  );
  const client = new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    maxRetries: 0,
    defaultHeaders: model.headers,
  });
  const params = buildOpenAICompletionsParams(
    model,
    args.context,
    {
      ...buildSimpleOptions({
        config: args.config,
        request: args.request,
      }),
      reasoningEffort:
        normalizeReasoning(
          args.config.providerOptions?.openai?.reasoningEffort,
        ) || args.request?.reasoning,
      toolChoice: args.request?.toolChoice,
      responseFormat: args.request?.responseFormat,
    },
    false,
  );

  const response = await client.chat.completions.create(
    params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    args.request?.signal ? { signal: args.request.signal } : undefined,
  );
  const choice = response.choices?.[0];
  const message = choice?.message;
  const stopReason = mapStopReason(choice?.finish_reason ?? "stop");

  const content: AssistantMessage["content"] = [];
  const reasoningMessage = message as Partial<
    Record<ChatCompletionReasoningField, unknown>
  > & {
    reasoning_details?: unknown;
  };
  const reasoningFields: ChatCompletionReasoningField[] = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ];
  for (const field of reasoningFields) {
    const thinking = readReasoningText(reasoningMessage[field]);
    if (!thinking) {
      continue;
    }
    content.push({
      type: "thinking",
      thinking,
      thinkingSignature: field,
    });
    break;
  }
  content.push(...readAssistantTextBlocks(message?.content));
  if (Array.isArray(message?.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!("function" in toolCall)) {
        continue;
      }
      let parsedArguments: Record<string, unknown> = {};
      try {
        parsedArguments = JSON.parse(
          toolCall.function.arguments || "{}",
        ) as Record<string, unknown>;
      } catch {
        parsedArguments = {};
      }
      content.push({
        type: "toolCall",
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parsedArguments,
      });
    }
  }
  if (Array.isArray(reasoningMessage.reasoning_details)) {
    for (const detail of reasoningMessage.reasoning_details as ChatCompletionReasoningDetail[]) {
      if (
        detail?.type !== "reasoning.encrypted" ||
        typeof detail.id !== "string" ||
        typeof detail.data !== "string"
      ) {
        continue;
      }
      const matchingToolCall = content.find(
        (block) => block.type === "toolCall" && block.id === detail.id,
      );
      if (matchingToolCall?.type === "toolCall") {
        matchingToolCall.thoughtSignature = JSON.stringify(detail);
      }
    }
  }

  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: parseOpenAIChatUsage(response.usage, model),
    stopReason,
    ...(stopReason === "error"
      ? {
          errorMessage:
            typeof choice?.finish_reason === "string"
              ? `Completion ended with finish_reason=${choice.finish_reason}`
              : "Completion ended in an error state",
        }
      : {}),
    timestamp: Date.now(),
  };
}

export async function completeManagedChat(args: {
  config: ManagedModelConfig;
  fallbackConfig?: ManagedModelConfig | null;
  context: Context;
  api?: ManagedProtocol;
  request?: ManagedCompletionRequest;
}): Promise<AssistantMessage> {
  const execute = async (config: ManagedModelConfig) => {
    const api = resolveManagedProtocol({ api: args.api, config });
    const message = await retryProviderRequest(
      () =>
        completeSimple(
          buildManagedModel(config, api, args.request?.headers),
          args.context,
          buildSimpleOptions({
            config,
            request: args.request,
          }),
        ),
      {
        signal: args.request?.signal,
        onRetry: ({ attempt, delayMs, error }) => {
          console.warn(
            `[managed-model] retrying provider request | model=${config.model} | attempt=${attempt} | delayMs=${delayMs} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || "Managed completion failed");
    }
    return message;
  };

  try {
    return await execute(args.config);
  } catch (error) {
    if (!args.fallbackConfig) {
      throw error;
    }
    console.warn(
      `[managed-model] primary model failed, attempting fallback | primary=${args.config.model} | fallback=${args.fallbackConfig.model} | error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return await execute(args.fallbackConfig);
  }
}

export function streamManagedChat(args: {
  config: ManagedModelConfig;
  fallbackConfig?: ManagedModelConfig | null;
  context: Context;
  api?: ManagedProtocol;
  request?: ManagedCompletionRequest;
}) {
  const streamForConfig = (config: ManagedModelConfig) => {
    const api = resolveManagedProtocol({ api: args.api, config });
    return streamSimple(
      buildManagedModel(config, api, args.request?.headers),
      args.context,
      buildSimpleOptions({
        config,
        request: args.request,
      }),
    );
  };

  const fallbackConfig = args.fallbackConfig ?? undefined;

  return (async function* () {
    let emittedOutput = false;
    const maxAttempts = DEFAULT_PROVIDER_RETRY_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        let retryPrimary = false;
        for await (const event of streamForConfig(args.config)) {
          if (event.type === "error" && !emittedOutput) {
            if (
              attempt < maxAttempts &&
              isRetryableProviderError(event.error)
            ) {
              const delayMs = retryDelayMs(attempt, event.error);
              console.warn(
                `[managed-model] retrying provider stream | model=${args.config.model} | attempt=${attempt} | delayMs=${delayMs} | error=${
                  event.error.errorMessage || event.reason
                }`,
              );
              await new Promise<void>((resolve) =>
                setTimeout(resolve, delayMs),
              );
              retryPrimary = true;
              break;
            }
            if (fallbackConfig) {
              console.warn(
                `[managed-model] primary model failed before streaming output, attempting fallback | primary=${args.config.model} | fallback=${fallbackConfig.model} | error=${
                  event.error.errorMessage || event.reason
                }`,
              );
              for await (const fallbackEvent of streamForConfig(
                fallbackConfig,
              )) {
                yield fallbackEvent;
              }
            } else {
              yield event;
            }
            return;
          }

          if (event.type !== "error") {
            emittedOutput = true;
          }
          yield event;
        }
        if (retryPrimary) {
          continue;
        }
        return;
      } catch (error) {
        if (emittedOutput) {
          throw error;
        }
        if (attempt < maxAttempts && isRetryableProviderError(error)) {
          const delayMs = retryDelayMs(attempt, error);
          console.warn(
            `[managed-model] retrying provider stream | model=${args.config.model} | attempt=${attempt} | delayMs=${delayMs} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        if (!isRetryableProviderError(error)) {
          throw error;
        }
        if (fallbackConfig) {
          console.warn(
            `[managed-model] primary model failed before streaming output, attempting fallback | primary=${args.config.model} | fallback=${fallbackConfig.model} | error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          for await (const fallbackEvent of streamForConfig(fallbackConfig)) {
            yield fallbackEvent;
          }
          return;
        }
        throw error;
      }
    }
  })();
}

export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
