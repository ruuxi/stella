/**
 * Stella provider HTTP surface.
 *
 * Stella clients talk to this namespace using `stella/*` model IDs. Stella
 * resolves the actual upstream provider/model server-side.
 */

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  getModeConfig,
  getModelConfig,
  type ManagedModelAudience,
  type ModelConfig,
} from "./agent/model";
import {
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
  type ManagedGatewayProvider,
} from "./lib/managed_gateway";
import { getClientAddressKey } from "./lib/http_utils";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import {
  corsPreflightHandler,
  errorResponse,
  getCorsHeaders,
  handleCorsRequest,
  jsonResponse,
} from "./http_shared/cors";
import {
  assistantText,
  buildContextFromChatMessages,
  buildManagedModel,
  completeManagedChat,
  streamManagedChat,
  type ManagedProtocol,
  usageSummaryFromAssistant,
} from "./runtime_ai/managed";
import type { AssistantMessageEvent, Context } from "./runtime_ai/types";
import {
  STELLA_DEFAULT_MODEL,
  isStellaModel,
  listStellaCatalogModels,
  listStellaDefaultSelections,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "./stella_models";
import { resolveManagedModelAccess } from "./lib/managed_billing";

/**
 * Per-anonymous-device cap on the Stella provider. Set effectively
 * unlimited while iterating on the provider; tighten before wide release.
 */
const MAX_ANON_REQUESTS = Number.MAX_SAFE_INTEGER;
/** Per-IP (or per-owner) cap on the `models` listing endpoint — paid users only. */
const STELLA_MODELS_RATE_LIMIT = 60;
const STELLA_MODELS_RATE_WINDOW_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const SSE_HEARTBEAT_INTERVAL_MS = 45_000;
const SSE_STREAM_OPEN_COMMENT = new TextEncoder().encode(
  ": stella-stream-open\n\n",
);
const SSE_HEARTBEAT_COMMENT = new TextEncoder().encode(": keepalive\n\n");
export const STELLA_API_BASE_PATH = "/api/stella/v1";
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/chat/completions`;
export const STELLA_RUNTIME_PATH = `${STELLA_API_BASE_PATH}/runtime`;
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;

type StellaRequestBody = Record<string, unknown>;

type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

type ManagedBillingUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

type ManagedRuntimeRequest = NonNullable<
  Parameters<typeof streamManagedChat>[0]["request"]
>;

type UpstreamHttpError = {
  status: number;
  message: string;
};

type AuthorizedStellaRequest = {
  ownerId: string;
  agentType: string;
  requestJson: StellaRequestBody;
  requestedModel: string;
  resolvedModel: string;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
  anonymousUsageRecord?: AnonymousUsageRecord;
};

type AnonymousUsageRecord = {
  deviceId: string;
  clientAddressKey?: string;
};

const STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS = new Set([
  "model",
  "agentType",
  "messages",
  "stream",
  "tools",
  "temperature",
  "reasoning",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
  "reasoning_effort",
  "tool_choice",
  "response_format",
]);

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
}

function toUpstreamHttpError(error: unknown): UpstreamHttpError | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as {
    status?: unknown;
    message?: unknown;
    error?: { message?: unknown };
  };
  const status = typeof record.status === "number" ? record.status : null;
  if (status === null || status < 400 || status >= 500) {
    return null;
  }

  const directMessage =
    typeof record.error?.message === "string"
      ? record.error.message
      : typeof record.message === "string"
        ? record.message.replace(/^\d+\s+/, "")
        : "Invalid Stella completion request";

  return {
    status,
    message: directMessage,
  };
}

async function checkDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runQuery(
      internal.ai_proxy_data.getDeviceUsage,
      {
        deviceId,
        nowMs: Date.now(),
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return (usage?.requestCount ?? 0) < MAX_ANON_REQUESTS;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

const scheduleAnonymousUsageRecord = async (
  ctx: ActionCtx,
  record: AnonymousUsageRecord | undefined,
): Promise<void> => {
  if (!record) return;
  try {
    await ctx.scheduler.runAfter(0, internal.ai_proxy_data.incrementDeviceUsage, {
      deviceId: record.deviceId,
      clientAddressKey: record.clientAddressKey,
    });
  } catch (error) {
    if (isAnonDeviceHashSaltMissingError(error)) {
      logMissingSaltOnce("stella-provider");
      return;
    }
    console.error("[stella-provider] Failed to record anonymous usage", error);
  }
};

async function parseRequestJson(
  request: Request,
): Promise<StellaRequestBody | null> {
  try {
    return (await request.json()) as StellaRequestBody;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ResolvedStellaModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  config: ModelConfig;
};

type ResolvedManagedServerModelConfig = {
  model: string;
  managedGatewayProvider: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
};

function resolveRequestedStellaModel(
  agentType: string,
  requestBody: StellaRequestBody,
  audience: ManagedModelAudience,
): ResolvedStellaModelSelection {
  const requestedModel =
    typeof requestBody.model === "string" && requestBody.model.trim().length > 0
      ? requestBody.model.trim()
      : STELLA_DEFAULT_MODEL;

  if (!isStellaModel(requestedModel)) {
    throw new Error(`Unsupported Stella model selection: ${requestedModel}`);
  }

  const parsedModel = parseStellaModelSelection(requestedModel);
  if (parsedModel?.kind === "default" || parsedModel?.kind === "mode") {
    const config =
      parsedModel.kind === "default"
        ? getModelConfig(agentType, audience)
        : getModeConfig(parsedModel.mode, audience);
    return {
      requestedModel,
      resolvedModel: config.model,
      config,
    };
  }

  const config = getModelConfig(agentType, audience);
  return {
    requestedModel,
    resolvedModel: resolveStellaModelSelection(
      agentType,
      requestedModel,
      audience,
    ),
    config,
  };
}

function estimateRequestTokens(requestBody: StellaRequestBody): TokenEstimate {
  const messages = Array.isArray(requestBody.messages)
    ? (requestBody.messages as Array<Record<string, unknown>>)
    : [];

  let inputTextLength = 0;
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") {
      inputTextLength += content.length;
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") {
        inputTextLength += text.length;
      }
    }
  }

  const maxCompletionTokens =
    typeof requestBody.max_completion_tokens === "number"
      ? requestBody.max_completion_tokens
      : typeof requestBody.max_tokens === "number"
        ? requestBody.max_tokens
        : typeof requestBody.maxOutputTokens === "number"
          ? requestBody.maxOutputTokens
          : 1024;

  return {
    inputTokens: Math.max(1, Math.ceil(inputTextLength / 4)),
    outputTokens: Math.max(
      0,
      Math.min(16_384, Math.floor(maxCompletionTokens)),
    ),
  };
}

function estimateContextTokens(args: {
  context: Context;
  request?: Record<string, unknown> | null;
}): TokenEstimate {
  const parts: string[] = [];
  if (typeof args.context.systemPrompt === "string") {
    parts.push(args.context.systemPrompt);
  }

  for (const message of args.context.messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if ("text" in block && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      if ("thinking" in block && typeof block.thinking === "string") {
        parts.push(block.thinking);
        continue;
      }
      if (
        "arguments" in block &&
        block.arguments &&
        typeof block.arguments === "object"
      ) {
        parts.push(JSON.stringify(block.arguments));
      }
    }
  }

  const requestRecord = args.request ?? null;
  const maxTokens =
    typeof requestRecord?.maxTokens === "number"
      ? requestRecord.maxTokens
      : typeof requestRecord?.max_completion_tokens === "number"
        ? requestRecord.max_completion_tokens
        : typeof requestRecord?.max_tokens === "number"
          ? requestRecord.max_tokens
          : 1024;

  const inputTextLength = parts.join("\n").length;
  return {
    inputTokens: Math.max(1, Math.ceil(inputTextLength / 4)),
    outputTokens: Math.max(0, Math.min(16_384, Math.floor(maxTokens))),
  };
}

function toManagedBillingUsage(
  message: Parameters<typeof usageSummaryFromAssistant>[0],
  estimate: TokenEstimate,
): ManagedBillingUsage {
  const usage = usageSummaryFromAssistant(message);

  return {
    inputTokens: usage?.inputTokens ?? estimate.inputTokens,
    outputTokens: usage?.outputTokens ?? estimate.outputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens,
    reasoningTokens: usage?.reasoningTokens,
  };
}

function toOpenAIUsage(args: {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}) {
  const promptTokens = args.inputTokens;
  const completionTokens = args.outputTokens;
  return {
    input_tokens: args.inputTokens,
    prompt_tokens: promptTokens,
    output_tokens: completionTokens,
    completion_tokens: completionTokens,
    total_tokens: args.totalTokens ?? promptTokens + completionTokens,
    ...(typeof args.cachedInputTokens === "number"
      ? {
          prompt_tokens_details: {
            cached_tokens: args.cachedInputTokens,
          },
        }
      : {}),
    ...(typeof args.reasoningTokens === "number"
      ? {
          completion_tokens_details: {
            reasoning_tokens: args.reasoningTokens,
          },
        }
      : {}),
  };
}

function mapStopReason(stopReason: string): "stop" | "length" | "tool_calls" {
  switch (stopReason) {
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    default:
      return "stop";
  }
}

function assistantReasoningContent(
  message: Awaited<ReturnType<typeof completeManagedChat>>,
): string | null {
  const reasoning = message.content
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        part.type === "thinking" && typeof part.thinking === "string",
    )
    .map((part) => part.thinking)
    .join("\n")
    .trim();
  return reasoning.length > 0 ? reasoning : null;
}

function assistantReasoningSignature(
  message: Awaited<ReturnType<typeof completeManagedChat>>,
): string | null {
  const signature = message.content
    .filter(
      (
        part,
      ): part is {
        type: "thinking";
        thinking: string;
        thinkingSignature?: string;
      } =>
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        typeof part.thinkingSignature === "string",
    )
    .map((part) => part.thinkingSignature?.trim() || "")
    .find((value) => value.startsWith("{"));
  return signature && signature.length > 0 ? signature : null;
}

function buildChatCompletionResponse(args: {
  id: string;
  created: number;
  model: string;
  message: Awaited<ReturnType<typeof completeManagedChat>>;
}) {
  const text = assistantText(args.message);
  const reasoningContent = assistantReasoningContent(args.message);
  const reasoningSignature = assistantReasoningSignature(args.message);
  const toolCalls = args.message.content
    .filter(
      (
        part,
      ): part is {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      } => part.type === "toolCall",
    )
    .map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    }));

  const usage = usageSummaryFromAssistant(args.message);

  return {
    id: args.id,
    object: "chat.completion",
    created: args.created,
    model: args.model,
    requestedModel: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(reasoningSignature
            ? { reasoning_signature: reasoningSignature }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapStopReason(args.message.stopReason),
      },
    ],
    usage: toOpenAIUsage({
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      reasoningTokens: usage?.reasoningTokens,
    }),
  };
}

function buildManagedRuntimeRequest(
  requestBody: StellaRequestBody,
  signal: AbortSignal,
): ManagedRuntimeRequest {
  const extraBody = Object.fromEntries(
    Object.entries(requestBody).filter(
      ([key]) => !STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS.has(key),
    ),
  );
  const sessionId =
    typeof requestBody.sessionId === "string" &&
    requestBody.sessionId.length > 0
      ? requestBody.sessionId
      : typeof requestBody.user === "string"
        ? requestBody.user
        : undefined;

  return {
    temperature:
      typeof requestBody.temperature === "number"
        ? requestBody.temperature
        : undefined,
    maxTokens:
      typeof requestBody.max_completion_tokens === "number"
        ? requestBody.max_completion_tokens
        : typeof requestBody.max_tokens === "number"
          ? requestBody.max_tokens
          : typeof requestBody.maxOutputTokens === "number"
            ? requestBody.maxOutputTokens
            : undefined,
    reasoning:
      requestBody.reasoning === "minimal" ||
      requestBody.reasoning === "low" ||
      requestBody.reasoning === "medium" ||
      requestBody.reasoning === "high" ||
      requestBody.reasoning === "xhigh"
        ? requestBody.reasoning
        : requestBody.reasoning_effort === "minimal" ||
            requestBody.reasoning_effort === "low" ||
            requestBody.reasoning_effort === "medium" ||
            requestBody.reasoning_effort === "high" ||
            requestBody.reasoning_effort === "xhigh"
          ? requestBody.reasoning_effort
          : undefined,
    toolChoice:
      requestBody.tool_choice === "auto" ||
      requestBody.tool_choice === "none" ||
      requestBody.tool_choice === "required" ||
      (requestBody.tool_choice && typeof requestBody.tool_choice === "object")
        ? (requestBody.tool_choice as ManagedRuntimeRequest["toolChoice"])
        : undefined,
    responseFormat: requestBody.response_format,
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    signal,
    sessionId,
    cacheRetention:
      requestBody.cacheRetention === "none" ||
      requestBody.cacheRetention === "short" ||
      requestBody.cacheRetention === "long"
        ? requestBody.cacheRetention
        : undefined,
  };
}

function buildManagedRuntimeRequestFromNativeRequest(
  requestBody: unknown,
  signal: AbortSignal,
): ManagedRuntimeRequest {
  const record = asRecord(requestBody) ?? {};
  const extraBody = asRecord(record.extraBody) ?? undefined;
  const headerRecord = asRecord(record.headers);
  const headers = headerRecord
    ? Object.fromEntries(
        Object.entries(headerRecord).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

  return {
    temperature:
      typeof record.temperature === "number" ? record.temperature : undefined,
    maxTokens:
      typeof record.maxTokens === "number"
        ? record.maxTokens
        : typeof record.max_completion_tokens === "number"
          ? record.max_completion_tokens
          : typeof record.max_tokens === "number"
            ? record.max_tokens
            : undefined,
    reasoning:
      record.reasoning === "minimal" ||
      record.reasoning === "low" ||
      record.reasoning === "medium" ||
      record.reasoning === "high" ||
      record.reasoning === "xhigh"
        ? record.reasoning
        : record.reasoning_effort === "minimal" ||
            record.reasoning_effort === "low" ||
            record.reasoning_effort === "medium" ||
            record.reasoning_effort === "high" ||
            record.reasoning_effort === "xhigh"
          ? record.reasoning_effort
          : undefined,
    toolChoice:
      record.toolChoice === "auto" ||
      record.toolChoice === "none" ||
      record.toolChoice === "required" ||
      (record.toolChoice && typeof record.toolChoice === "object")
        ? (record.toolChoice as ManagedRuntimeRequest["toolChoice"])
        : record.tool_choice === "auto" ||
            record.tool_choice === "none" ||
            record.tool_choice === "required" ||
            (record.tool_choice && typeof record.tool_choice === "object")
          ? (record.tool_choice as ManagedRuntimeRequest["toolChoice"])
          : undefined,
    responseFormat: record.responseFormat ?? record.response_format,
    extraBody,
    signal,
    headers,
    sessionId:
      typeof record.sessionId === "string" && record.sessionId.length > 0
        ? record.sessionId
        : undefined,
    cacheRetention:
      record.cacheRetention === "none" ||
      record.cacheRetention === "short" ||
      record.cacheRetention === "long"
        ? record.cacheRetention
        : undefined,
  };
}

function parseNativeContext(value: unknown): Context | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.messages)) {
    return null;
  }
  return record as unknown as Context;
}

function buildStreamingErrorPayload(args: {
  id: string;
  created: number;
  model: string;
  message: string;
}) {
  return {
    id: args.id,
    object: "chat.completion.chunk",
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "error",
      },
    ],
    error: {
      message: args.message,
      type: "server_error",
    },
  };
}

function resolveManagedProtocol(args: {
  resolvedModel: string;
  managedGatewayProvider: ManagedGatewayProvider;
}): ManagedProtocol {
  const normalizedModel = args.resolvedModel.trim().toLowerCase();
  if (args.managedGatewayProvider === "anthropic") {
    return "anthropic-messages";
  }
  if (args.managedGatewayProvider === "google") {
    return "google-generative-ai";
  }
  if (
    args.managedGatewayProvider === "fireworks" ||
    args.managedGatewayProvider === "openai" ||
    normalizedModel.startsWith("openai/")
  ) {
    return "openai-responses";
  }
  return "openai-completions";
}

async function authorizeStellaRequest(
  ctx: ActionCtx,
  request: Request,
  expectedPath: string,
): Promise<AuthorizedStellaRequest | Response> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.tokenIdentifier;
  const isAnonymous =
    (identity as Record<string, unknown>).isAnonymous === true;
  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";
  let anonymousUsageRecord: AnonymousUsageRecord | undefined;

  const url = new URL(request.url);
  if (!url.pathname.endsWith(expectedPath)) {
    return stellaProviderErrorResponse(
      404,
      "Stella provider path not found",
      request,
    );
  }

  if (isAnonymous) {
    const deviceId = `anon-jwt:${ownerId}`;
    const clientAddressKey = getClientAddressKey(request);
    anonymousUsageRecord = {
      deviceId,
      ...(clientAddressKey ? { clientAddressKey } : {}),
    };
    const allowed = await checkDeviceRateLimit(ctx, deviceId, clientAddressKey);
    if (!allowed) {
      return stellaProviderErrorResponse(
        429,
        "Rate limit exceeded. Please create an account for continued access.",
        request,
      );
    }
  } else {
    const subscriptionCheck = await resolveManagedModelAccess(ctx, ownerId);
    modelAudience = subscriptionCheck.modelAudience;

    const usageBlocked =
      !subscriptionCheck.allowed && subscriptionCheck.plan !== "free";
    if (usageBlocked) {
      const response = stellaProviderErrorResponse(
        429,
        subscriptionCheck.message,
        request,
      );
      response.headers.set(
        "Retry-After",
        String(
          Math.ceil(
            (subscriptionCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000,
          ),
        ),
      );
      return response;
    }

    if (subscriptionCheck.plan !== "free") {
      const rateCheck = await ctx.runMutation(
        internal.ai_proxy_data.checkProxyRateLimit,
        {
          ownerId,
          tokensPerMinuteLimit: subscriptionCheck.tokensPerMinute,
        },
      );

      if (!rateCheck.allowed) {
        const response = stellaProviderErrorResponse(
          429,
          "Rate limit exceeded",
          request,
        );
        response.headers.set(
          "Retry-After",
          String(
            Math.ceil(
              (rateCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000,
            ),
          ),
        );
        return response;
      }
    }
  }

  const requestJson = await parseRequestJson(request);
  if (!requestJson) {
    return stellaProviderErrorResponse(
      400,
      "Stella request body must be valid JSON",
      request,
    );
  }

  const headerAgentType = request.headers.get("X-Stella-Agent-Type")?.trim();
  const bodyAgentType =
    typeof requestJson.agentType === "string" &&
    requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : undefined;
  const agentType = headerAgentType || bodyAgentType || "general";

  let selection: ResolvedStellaModelSelection;
  try {
    selection = resolveRequestedStellaModel(
      agentType,
      requestJson,
      modelAudience,
    );
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      request,
    );
  }

  const { requestedModel, resolvedModel, config } = selection;
  const managedGatewayProvider: ManagedGatewayProvider =
    resolveManagedGatewayProvider({
      model: resolvedModel,
      configuredProvider: config.managedGatewayProvider,
    });
  const managedGateway = resolveManagedGatewayConfig({
    model: resolvedModel,
    configuredProvider: config.managedGatewayProvider,
  });
  if (!process.env[managedGateway.apiKeyEnvVar]?.trim()) {
    return stellaProviderErrorResponse(
      503,
      "Stella upstream gateway is not configured",
      request,
    );
  }

  const managedApi = resolveManagedProtocol({
    resolvedModel,
    managedGatewayProvider,
  });

  console.log(
    `[stella-provider] agent=${agentType} | requestedModel=${requestedModel} | resolvedModel=${resolvedModel} | fallbackModel=${config.fallback ?? "none"} | gateway=${managedGatewayProvider} | api=${managedApi}`,
  );

  const fallbackModelConfig: ResolvedManagedServerModelConfig | undefined =
    config.fallback
      ? {
          model: config.fallback,
          managedGatewayProvider: resolveManagedGatewayProvider({
            model: config.fallback,
            configuredProvider: config.fallbackManagedGatewayProvider,
          }),
          temperature: config.temperature,
          maxOutputTokens: config.maxOutputTokens,
          providerOptions: config.fallbackProviderOptions as
            | Record<string, Record<string, unknown>>
            | undefined,
        }
      : undefined;

  return {
    ownerId,
    agentType,
    requestJson,
    requestedModel,
    resolvedModel,
    managedApi,
    serverModelConfig: {
      model: resolvedModel,
      managedGatewayProvider,
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
      providerOptions: config.providerOptions as
        | Record<string, Record<string, unknown>>
        | undefined,
    },
    fallbackModelConfig,
    anonymousUsageRecord,
  };
}

async function createStreamingRuntimeResponse(args: {
  request: Request;
  ctx: ActionCtx;
  ownerId: string;
  agentType: string;
  modelId: string;
  tokenEstimate: TokenEstimate;
  requestBody: StellaRequestBody;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
}): Promise<Response> {
  const {
    request,
    ctx,
    ownerId,
    agentType,
    modelId,
    tokenEstimate,
    requestBody,
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
  } = args;
  const origin = request.headers.get("origin");
  const responseHeaders: Record<string, string> = {
    ...getCorsHeaders(origin),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
  };
  const requestStartedAt = Date.now();
  const responseId = `chatcmpl_${requestStartedAt}`;
  const created = Math.floor(requestStartedAt / 1000);
  const encoder = new TextEncoder();
  const primaryManagedModel = buildManagedModel(serverModelConfig, managedApi);

  const sendChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: unknown,
  ) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastDownstreamWriteAt = Date.now();
      let closed = false;
      let nextToolIndex = 0;
      const toolIndexByContentIndex = new Map<number, number>();

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        request.signal.removeEventListener("abort", onClientAbort);
      };

      const enqueueComment = (chunk: Uint8Array) => {
        if (closed) return;
        controller.enqueue(chunk);
        lastDownstreamWriteAt = Date.now();
      };

      const onClientAbort = () => {
        try {
          controller.close();
        } catch {
          // Ignore double-close races with the runtime loop.
        } finally {
          closeStream();
        }
      };

      const heartbeatTimer = setInterval(() => {
        if (closed) {
          clearInterval(heartbeatTimer);
          return;
        }
        if (Date.now() - lastDownstreamWriteAt >= SSE_HEARTBEAT_INTERVAL_MS) {
          try {
            enqueueComment(SSE_HEARTBEAT_COMMENT);
          } catch {
            closeStream();
          }
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", onClientAbort, { once: true });
      enqueueComment(SSE_STREAM_OPEN_COMMENT);

      const runtimeStream = streamManagedChat({
        config: serverModelConfig,
        fallbackConfig: fallbackModelConfig,
        context: buildContextFromChatMessages(
          requestBody.messages,
          requestBody.tools,
        ),
        api: managedApi,
        request: buildManagedRuntimeRequest(requestBody, request.signal),
      });
      const iterator = runtimeStream[Symbol.asyncIterator]();

      const handleRuntimeEvent = async (event: AssistantMessageEvent) => {
        if (event.type === "text_delta") {
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: event.delta },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "thinking_delta") {
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: event.delta },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "thinking_end") {
          const partial = event.partial.content[event.contentIndex];
          if (
            partial &&
            partial.type === "thinking" &&
            typeof partial.thinkingSignature === "string" &&
            partial.thinkingSignature.trim().startsWith("{")
          ) {
            sendChunk(controller, {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_signature: partial.thinkingSignature },
                },
              ],
            });
            lastDownstreamWriteAt = Date.now();
          }
          return false;
        }

        if (
          event.type === "toolcall_start" ||
          event.type === "toolcall_delta"
        ) {
          const partial = event.partial.content[event.contentIndex];
          if (!partial || partial.type !== "toolCall") {
            return false;
          }

          const toolIndex =
            toolIndexByContentIndex.get(event.contentIndex) ?? nextToolIndex++;
          toolIndexByContentIndex.set(event.contentIndex, toolIndex);
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: partial.id,
                      type: "function",
                      function: {
                        name: partial.name,
                        arguments:
                          event.type === "toolcall_delta" ? event.delta : "",
                      },
                    },
                  ],
                },
              },
            ],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "done") {
          const usage = usageSummaryFromAssistant(event.message);
          const executedModel = event.message.model || modelId;
          const fallbackUsed = executedModel !== primaryManagedModel.id;
          console.log(
            `[stella-provider] completed agent=${agentType} | requestedModel=${modelId} | primaryModel=${primaryManagedModel.id} | model=${executedModel} | fallbackUsed=${fallbackUsed}`,
          );
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: mapStopReason(event.message.stopReason),
              },
            ],
            usage: toOpenAIUsage({
              inputTokens: usage?.inputTokens ?? tokenEstimate.inputTokens,
              outputTokens: usage?.outputTokens ?? tokenEstimate.outputTokens,
              totalTokens: usage?.totalTokens,
              cachedInputTokens: usage?.cachedInputTokens,
              reasoningTokens: usage?.reasoningTokens,
            }),
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: executedModel,
            durationMs: Date.now() - requestStartedAt,
            success: true,
            ...toManagedBillingUsage(event.message, tokenEstimate),
          });
          if (!closed) {
            controller.close();
          }
          return true;
        }

        if (event.type === "error") {
          const errorMessage =
            event.error.errorMessage || "Streaming completion failed";
          console.error("[stella-provider] Streaming error:", errorMessage);
          sendChunk(
            controller,
            buildStreamingErrorPayload({
              id: responseId,
              created,
              model: modelId,
              message: errorMessage,
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed) {
            controller.close();
          }
          return true;
        }

        return false;
      };

      void (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            if (await handleRuntimeEvent(next.value)) {
              return;
            }
          }
          if (!closed) {
            controller.close();
          }
        } catch (error) {
          console.error("[stella-provider] Streaming error:", error);
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed && !request.signal.aborted) {
            sendChunk(
              controller,
              buildStreamingErrorPayload({
                id: responseId,
                created,
                model: modelId,
                message: "Failed to generate Stella completion",
              }),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } finally {
          closeStream();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

type StellaAssistantMessageEventPayload =
  | { type: "start"; api: ManagedProtocol; provider: string; model: string }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | {
      type: "thinking_end";
      contentIndex: number;
      content?: string;
      contentSignature?: string;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id: string;
      toolName: string;
    }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | {
      type: "done";
      reason: Extract<AssistantMessageEvent["type"], "done"> extends never
        ? never
        : "stop" | "length" | "toolUse";
      usage: Awaited<ReturnType<typeof completeManagedChat>>["usage"];
    }
  | {
      type: "error";
      reason: "aborted" | "error";
      errorMessage?: string;
      usage: Awaited<ReturnType<typeof completeManagedChat>>["usage"];
    };

function mapAssistantEventToStellaEvent(args: {
  event: AssistantMessageEvent;
  partialModel: ReturnType<typeof buildManagedModel>;
}): StellaAssistantMessageEventPayload | null {
  const { event, partialModel } = args;

  switch (event.type) {
    case "start":
      return {
        type: "start",
        api: partialModel.api,
        provider: partialModel.provider,
        model: partialModel.id,
      };
    case "text_start":
      return { type: "text_start", contentIndex: event.contentIndex };
    case "text_delta":
      return {
        type: "text_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        contentSignature:
          content && content.type === "text"
            ? content.textSignature
            : undefined,
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "thinking_delta":
      return {
        type: "thinking_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content:
          content && content.type === "thinking"
            ? content.thinking
            : event.content,
        contentSignature:
          content && content.type === "thinking"
            ? content.thinkingSignature
            : undefined,
      };
    }
    case "toolcall_start": {
      const toolCall = event.partial.content[event.contentIndex];
      if (!toolCall || toolCall.type !== "toolCall") {
        return null;
      }
      return {
        type: "toolcall_start",
        contentIndex: event.contentIndex,
        id: toolCall.id,
        toolName: toolCall.name,
      };
    }
    case "toolcall_delta":
      return {
        type: "toolcall_delta",
        contentIndex: event.contentIndex,
        delta: event.delta,
      };
    case "toolcall_end":
      return { type: "toolcall_end", contentIndex: event.contentIndex };
    case "done":
      return {
        type: "done",
        reason: event.reason,
        usage: event.message.usage,
      };
    case "error":
      return {
        type: "error",
        reason: event.reason,
        errorMessage: event.error.errorMessage,
        usage: event.error.usage,
      };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

async function createNativeRuntimeResponse(args: {
  request: Request;
  ctx: ActionCtx;
  ownerId: string;
  agentType: string;
  modelId: string;
  tokenEstimate: TokenEstimate;
  context: Context;
  nativeRequest: Record<string, unknown> | null;
  managedApi: ManagedProtocol;
  serverModelConfig: ResolvedManagedServerModelConfig;
  fallbackModelConfig?: ResolvedManagedServerModelConfig;
  anonymousUsageRecord?: AnonymousUsageRecord;
}): Promise<Response> {
  const {
    request,
    ctx,
    ownerId,
    agentType,
    modelId,
    tokenEstimate,
    context,
    nativeRequest,
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
    anonymousUsageRecord,
  } = args;
  const origin = request.headers.get("origin");
  const requestStartedAt = Date.now();
  const encoder = new TextEncoder();
  const managedModel = buildManagedModel(serverModelConfig, managedApi);
  const responseHeaders: Record<string, string> = {
    ...getCorsHeaders(origin),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
  };

  const sendEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: StellaAssistantMessageEventPayload,
  ) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastDownstreamWriteAt = Date.now();
      let closed = false;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeatTimer);
        request.signal.removeEventListener("abort", onClientAbort);
      };

      const enqueueComment = (chunk: Uint8Array) => {
        if (closed) return;
        controller.enqueue(chunk);
        lastDownstreamWriteAt = Date.now();
      };

      const onClientAbort = () => {
        try {
          controller.close();
        } catch {
          // Ignore double-close races with the runtime loop.
        } finally {
          closeStream();
        }
      };

      const heartbeatTimer = setInterval(() => {
        if (closed) {
          clearInterval(heartbeatTimer);
          return;
        }
        if (Date.now() - lastDownstreamWriteAt >= SSE_HEARTBEAT_INTERVAL_MS) {
          try {
            enqueueComment(SSE_HEARTBEAT_COMMENT);
          } catch {
            closeStream();
          }
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      request.signal.addEventListener("abort", onClientAbort, { once: true });
      enqueueComment(SSE_STREAM_OPEN_COMMENT);

      const runtimeStream = streamManagedChat({
        config: serverModelConfig,
        fallbackConfig: fallbackModelConfig,
        context,
        api: managedApi,
        request: buildManagedRuntimeRequestFromNativeRequest(
          nativeRequest,
          request.signal,
        ),
      });
      const iterator = runtimeStream[Symbol.asyncIterator]();
      let didRecordAnonymousUsage = false;

      const handleRuntimeEvent = async (event: AssistantMessageEvent) => {
        const payload = mapAssistantEventToStellaEvent({
          event,
          partialModel: managedModel,
        });
        if (payload) {
          sendEvent(controller, payload);
          lastDownstreamWriteAt = Date.now();
        }

        if (event.type === "done") {
          const executedModel = event.message.model || modelId;
          const fallbackUsed = executedModel !== managedModel.id;
          console.log(
            `[stella-provider] completed agent=${agentType} | requestedModel=${modelId} | primaryModel=${managedModel.id} | model=${executedModel} | fallbackUsed=${fallbackUsed}`,
          );
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: executedModel,
            durationMs: Date.now() - requestStartedAt,
            success: true,
            ...toManagedBillingUsage(event.message, tokenEstimate),
          });
          if (!didRecordAnonymousUsage) {
            didRecordAnonymousUsage = true;
            await scheduleAnonymousUsageRecord(ctx, anonymousUsageRecord);
          }
          if (!closed) {
            controller.close();
          }
          return true;
        }

        if (event.type === "error") {
          console.error(
            "[stella-provider] Native streaming error:",
            event.error.errorMessage || "Streaming completion failed",
          );
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed) {
            controller.close();
          }
          return true;
        }

        return false;
      };

      void (async () => {
        try {
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            if (await handleRuntimeEvent(next.value)) {
              return;
            }
          }
          if (!closed) {
            controller.close();
          }
        } catch (error) {
          console.error("[stella-provider] Native streaming error:", error);
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId,
            agentType,
            model: modelId,
            durationMs: Date.now() - requestStartedAt,
            success: false,
            inputTokens: tokenEstimate.inputTokens,
            outputTokens: tokenEstimate.outputTokens,
          });
          if (!closed && !request.signal.aborted) {
            sendEvent(controller, {
              type: "error",
              reason: "error",
              errorMessage: "Failed to generate Stella completion",
              usage: {
                input: tokenEstimate.inputTokens,
                output: tokenEstimate.outputTokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens:
                  tokenEstimate.inputTokens + tokenEstimate.outputTokens,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            });
            controller.close();
          }
        } finally {
          closeStream();
        }
      })();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

export const stellaProviderModels = httpAction(async (ctx, request) =>
  handleCorsRequest(request, async (origin) => {
    const identity = await ctx.auth.getUserIdentity();

    let audience: ManagedModelAudience = identity
      ? (identity as Record<string, unknown>).isAnonymous === true
        ? "anonymous"
        : "free"
      : "anonymous";

    let rateLimitPaidSubscriber = false;
    if (
      identity &&
      (identity as Record<string, unknown>).isAnonymous !== true
    ) {
      const access = await resolveManagedModelAccess(
        ctx,
        identity.tokenIdentifier,
      );
      audience = access.modelAudience;
      rateLimitPaidSubscriber = access.plan !== "free";
    }

    if (rateLimitPaidSubscriber) {
      const rateLimit = await ctx.runMutation(
        internal.rate_limits.consumeWebhookRateLimit,
        {
          scope: "stella_models",
          key: identity!.tokenIdentifier,
          limit: STELLA_MODELS_RATE_LIMIT,
          windowMs: STELLA_MODELS_RATE_WINDOW_MS,
          blockMs: STELLA_MODELS_RATE_WINDOW_MS,
        },
      );
      if (!rateLimit.allowed) {
        const response = stellaProviderErrorResponse(
          429,
          "Rate limit exceeded",
          request,
        );
        response.headers.set(
          "Retry-After",
          String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        );
        return response;
      }
    }

    return jsonResponse(
      {
        data: listStellaCatalogModels(audience).map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          type: model.type,
          upstreamModel: model.upstreamModel,
        })),
        defaults: listStellaDefaultSelections(audience),
      },
      200,
      origin,
    );
  }),
);

export const stellaProviderChatCompletions = httpAction(
  async (ctx, request) => {
    const authorized = await authorizeStellaRequest(
      ctx,
      request,
      STELLA_CHAT_COMPLETIONS_PATH,
    );
    if (authorized instanceof Response) {
      return authorized;
    }

    const {
      ownerId,
      agentType,
      requestJson,
      resolvedModel,
      managedApi,
      serverModelConfig,
      fallbackModelConfig,
    } = authorized;
    const tokenEstimate = estimateRequestTokens(requestJson);
    const isStreaming = requestJson.stream === true;

    if (isStreaming) {
      return await createStreamingRuntimeResponse({
        request,
        ctx,
        ownerId,
        agentType,
        modelId: resolvedModel,
        tokenEstimate,
        requestBody: requestJson,
        managedApi,
        serverModelConfig,
        fallbackModelConfig,
      });
    }

    const startedAt = Date.now();
    try {
      const message = await completeManagedChat({
        config: serverModelConfig,
        fallbackConfig: fallbackModelConfig,
        context: buildContextFromChatMessages(
          requestJson.messages,
          requestJson.tools,
        ),
        api: managedApi,
        request: buildManagedRuntimeRequest(requestJson, request.signal),
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new Error(message.errorMessage || "Stella completion failed");
      }

      const executedModel = message.model || resolvedModel;
      const primaryManagedModel = buildManagedModel(serverModelConfig, managedApi);
      const fallbackUsed = executedModel !== primaryManagedModel.id;
      console.log(
        `[stella-provider] completed agent=${agentType} | requestedModel=${resolvedModel} | primaryModel=${primaryManagedModel.id} | model=${executedModel} | fallbackUsed=${fallbackUsed}`,
      );

      await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
        ownerId,
        agentType,
        model: executedModel,
        durationMs: Date.now() - startedAt,
        success: true,
        ...toManagedBillingUsage(message, tokenEstimate),
      });

      return jsonResponse(
        buildChatCompletionResponse({
          id: `chatcmpl_${startedAt}`,
          created: Math.floor(startedAt / 1000),
          model: executedModel,
          message,
        }),
        200,
        request.headers.get("origin"),
      );
    } catch (error) {
      console.error("[stella-provider] Completion error:", error);
      const upstreamHttpError = toUpstreamHttpError(error);
      await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
        ownerId,
        agentType,
        model: resolvedModel,
        durationMs: Date.now() - startedAt,
        success: false,
        inputTokens: tokenEstimate.inputTokens,
        outputTokens: tokenEstimate.outputTokens,
      });
      return stellaProviderErrorResponse(
        upstreamHttpError?.status ?? 502,
        upstreamHttpError?.message ?? "Failed to generate Stella completion",
        request,
      );
    }
  },
);

export const stellaProviderRuntime = httpAction(async (ctx, request) => {
  const authorized = await authorizeStellaRequest(
    ctx,
    request,
    STELLA_RUNTIME_PATH,
  );
  if (authorized instanceof Response) {
    return authorized;
  }

  const {
    ownerId,
    agentType,
    requestJson,
    resolvedModel,
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
    anonymousUsageRecord,
  } = authorized;

  const context = parseNativeContext(requestJson.context);
  if (!context) {
    return stellaProviderErrorResponse(
      400,
      "Stella runtime request must include a valid context object",
      request,
    );
  }

  return await createNativeRuntimeResponse({
    request,
    ctx,
    ownerId,
    agentType,
    modelId: resolvedModel,
    tokenEstimate: estimateContextTokens({
      context,
      request: asRecord(requestJson.request),
    }),
    context,
    nativeRequest: asRecord(requestJson.request),
    managedApi,
    serverModelConfig,
    fallbackModelConfig,
    anonymousUsageRecord,
  });
});

export { corsPreflightHandler as stellaProviderOptions };
