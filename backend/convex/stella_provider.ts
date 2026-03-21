/**
 * Stella provider HTTP surface.
 *
 * Stella clients talk to this namespace using `stella/*` model IDs. Stella
 * resolves the actual upstream provider/model server-side.
 */

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getModelConfig, MANAGED_GATEWAY, type ManagedModelAudience } from "./agent/model";
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
  completeManagedChat,
  streamManagedChat,
  usageSummaryFromAssistant,
} from "./runtime_ai/managed";
import type { AssistantMessageEvent } from "./runtime_ai/types";
import {
  STELLA_DEFAULT_MODEL,
  isStellaModel,
  listStellaCatalogModels,
  resolveStellaModelSelection,
} from "./stella_models";
import { resolveManagedModelAccess } from "./lib/managed_billing";

/** Local/testing: high anon allowance; re-tighten before production. */
const MAX_ANON_REQUESTS = 10_000_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const SSE_HEARTBEAT_INTERVAL_MS = 45_000;
const SSE_STREAM_OPEN_COMMENT = new TextEncoder().encode(": stella-stream-open\n\n");
const SSE_HEARTBEAT_COMMENT = new TextEncoder().encode(": keepalive\n\n");

export const STELLA_API_BASE_PATH = "/api/stella/v1";
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/chat/completions`;
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

const STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS = new Set([
  "model",
  "agentType",
  "messages",
  "stream",
  "tools",
  "temperature",
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

  const directMessage = typeof record.error?.message === "string"
    ? record.error.message
    : typeof record.message === "string"
      ? record.message.replace(/^\d+\s+/, "")
      : "Invalid Stella completion request";

  return {
    status,
    message: directMessage,
  };
}

function toUpstreamHttpErrorFromMessage(message: string | undefined): UpstreamHttpError | null {
  if (!message) {
    return null;
  }

  const trimmed = message.trim();
  const match = trimmed.match(/^(\d{3})\s+(.+)$/s);
  if (!match) {
    return null;
  }

  const status = Number(match[1]);
  if (!Number.isFinite(status) || status < 400 || status >= 500) {
    return null;
  }

  return {
    status,
    message: match[2].trim(),
  };
}

async function consumeDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runMutation(
      internal.ai_proxy_data.consumeDeviceAllowance,
      {
        deviceId,
        maxRequests: MAX_ANON_REQUESTS,
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return usage.allowed;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

async function parseRequestJson(request: Request): Promise<StellaRequestBody | null> {
  try {
    return (await request.json()) as StellaRequestBody;
  } catch {
    return null;
  }
}

function resolveRequestedStellaModel(
  agentType: string,
  requestBody: StellaRequestBody,
  audience: ManagedModelAudience,
): string {
  const requestedModel =
    typeof requestBody.model === "string" && requestBody.model.trim().length > 0
      ? requestBody.model.trim()
      : STELLA_DEFAULT_MODEL;

  if (!isStellaModel(requestedModel)) {
    throw new Error(`Unsupported Stella model selection: ${requestedModel}`);
  }

  return resolveStellaModelSelection(agentType, requestedModel, audience);
}

function estimateRequestTokens(requestBody: StellaRequestBody): TokenEstimate {
  const messages = Array.isArray(requestBody.messages)
    ? requestBody.messages as Array<Record<string, unknown>>
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
    outputTokens: Math.max(0, Math.min(16_384, Math.floor(maxCompletionTokens))),
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

function buildChatCompletionResponse(args: {
  id: string;
  created: number;
  model: string;
  message: Awaited<ReturnType<typeof completeManagedChat>>;
}) {
  const text = assistantText(args.message);
  const toolCalls = args.message.content
    .filter((part): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
      part.type === "toolCall")
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
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(args.message.stopReason),
    }],
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
    Object.entries(requestBody).filter(([key]) =>
      !STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS.has(key),
    ),
  );

  return {
    temperature:
      typeof requestBody.temperature === "number" ? requestBody.temperature : undefined,
    maxTokens:
      typeof requestBody.max_completion_tokens === "number"
        ? requestBody.max_completion_tokens
        : typeof requestBody.max_tokens === "number"
          ? requestBody.max_tokens
          : typeof requestBody.maxOutputTokens === "number"
            ? requestBody.maxOutputTokens
            : undefined,
    reasoning:
      requestBody.reasoning_effort === "minimal"
      || requestBody.reasoning_effort === "low"
      || requestBody.reasoning_effort === "medium"
      || requestBody.reasoning_effort === "high"
      || requestBody.reasoning_effort === "xhigh"
        ? requestBody.reasoning_effort
        : undefined,
    toolChoice:
      requestBody.tool_choice === "auto"
      || requestBody.tool_choice === "none"
      || requestBody.tool_choice === "required"
      || (requestBody.tool_choice && typeof requestBody.tool_choice === "object")
        ? requestBody.tool_choice as ManagedRuntimeRequest["toolChoice"]
        : undefined,
    responseFormat: requestBody.response_format,
    extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
    signal,
  };
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
    choices: [{
      index: 0,
      delta: {},
      finish_reason: "error",
    }],
    error: {
      message: args.message,
      type: "server_error",
    },
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
  serverModelConfig: {
    model: string;
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: Record<string, Record<string, unknown>>;
  };
}): Promise<Response> {
  const {
    request,
    ctx,
    ownerId,
    agentType,
    modelId,
    tokenEstimate,
    requestBody,
    serverModelConfig,
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
  const runtimeRequest = buildManagedRuntimeRequest(requestBody, request.signal);
  const runtimeStream = streamManagedChat({
    config: serverModelConfig,
    context: buildContextFromChatMessages(requestBody.messages, requestBody.tools),
    request: runtimeRequest,
  });
  const iterator = runtimeStream[Symbol.asyncIterator]();
  const prefetched = await iterator.next();
  const prefetchedEvent = prefetched.done ? null : prefetched.value;
  const prefetchedResult = prefetched.done ? await runtimeStream.result() : null;

  if (
    prefetchedEvent?.type === "error"
    || prefetchedResult?.stopReason === "error"
    || prefetchedResult?.stopReason === "aborted"
  ) {
    const errorMessage =
      prefetchedEvent?.type === "error"
        ? (prefetchedEvent.error.errorMessage || "Failed to generate Stella completion")
        : (prefetchedResult?.errorMessage || "Failed to generate Stella completion");
    const upstreamHttpError = toUpstreamHttpErrorFromMessage(errorMessage);
    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId,
      agentType,
      model: modelId,
      durationMs: Date.now() - requestStartedAt,
      success: false,
      inputTokens: tokenEstimate.inputTokens,
      outputTokens: tokenEstimate.outputTokens,
    });
    return stellaProviderErrorResponse(
      upstreamHttpError?.status ?? 502,
      upstreamHttpError?.message ?? errorMessage,
      request,
    );
  }

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

      const handleRuntimeEvent = async (event: AssistantMessageEvent) => {
        if (event.type === "text_delta") {
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: { content: event.delta },
            }],
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
            choices: [{
              index: 0,
              delta: { reasoning_content: event.delta },
            }],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
          const partial = event.partial.content[event.contentIndex];
          if (!partial || partial.type !== "toolCall") {
            return false;
          }

          const toolIndex = toolIndexByContentIndex.get(event.contentIndex) ?? nextToolIndex++;
          toolIndexByContentIndex.set(event.contentIndex, toolIndex);
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolIndex,
                  id: partial.id,
                  type: "function",
                  function: {
                    name: partial.name,
                    arguments: event.type === "toolcall_delta" ? event.delta : "",
                  },
                }],
              },
            }],
          });
          lastDownstreamWriteAt = Date.now();
          return false;
        }

        if (event.type === "done") {
          const usage = usageSummaryFromAssistant(event.message);
          sendChunk(controller, {
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: mapStopReason(event.message.stopReason),
            }],
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
            model: modelId,
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
          const errorMessage = event.error.errorMessage || "Streaming completion failed";
          console.error("[stella-provider] Streaming error:", errorMessage);
          sendChunk(controller, buildStreamingErrorPayload({
            id: responseId,
            created,
            model: modelId,
            message: errorMessage,
          }));
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
          if (prefetchedEvent && await handleRuntimeEvent(prefetchedEvent)) {
            return;
          }

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

export const stellaProviderModels = httpAction(async (ctx, request) =>
  handleCorsRequest(request, async (origin) => {
    const identity = await ctx.auth.getUserIdentity();
    let audience: ManagedModelAudience = identity
      ? ((identity as Record<string, unknown>).isAnonymous === true ? "anonymous" : "free")
      : "anonymous";

    if (identity && (identity as Record<string, unknown>).isAnonymous !== true) {
      const access = await resolveManagedModelAccess(ctx, identity.subject);
      audience = access.modelAudience;
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
      },
      200,
      origin,
    );
  }),
);

export const stellaProviderChatCompletions = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.subject;
  const isAnonymous = (identity as Record<string, unknown>).isAnonymous === true;
  let modelAudience: ManagedModelAudience = isAnonymous ? "anonymous" : "free";

  const url = new URL(request.url);
  if (!url.pathname.endsWith("/chat/completions")) {
    return stellaProviderErrorResponse(404, "Stella provider path not found", request);
  }

  if (isAnonymous) {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      `anon-jwt:${ownerId}`,
      getClientAddressKey(request),
    );
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

    if (!subscriptionCheck.allowed) {
      const response = stellaProviderErrorResponse(429, subscriptionCheck.message, request);
      response.headers.set(
        "Retry-After",
        String(Math.ceil((subscriptionCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000)),
      );
      return response;
    }

    const rateCheck = await ctx.runMutation(
      internal.ai_proxy_data.checkProxyRateLimit,
      {
        ownerId,
        tokensPerMinuteLimit: subscriptionCheck.tokensPerMinute,
      },
    );

    if (!rateCheck.allowed) {
      const response = stellaProviderErrorResponse(429, "Rate limit exceeded", request);
      response.headers.set(
        "Retry-After",
        String(Math.ceil((rateCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000)),
      );
      return response;
    }
  }

  if (!process.env[MANAGED_GATEWAY.apiKeyEnvVar]?.trim()) {
    return stellaProviderErrorResponse(
      503,
      "Stella upstream gateway is not configured",
      request,
    );
  }

  const requestJson = await parseRequestJson(request);
  if (!requestJson) {
    return stellaProviderErrorResponse(400, "Stella request body must be valid JSON", request);
  }

  const headerAgentType = request.headers.get("X-Stella-Agent-Type")?.trim();
  const bodyAgentType =
    typeof requestJson.agentType === "string" && requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : undefined;
  const agentType = headerAgentType || bodyAgentType || "general";

  let resolvedModel: string;
  try {
    resolvedModel = resolveRequestedStellaModel(agentType, requestJson, modelAudience);
  } catch (error) {
    return stellaProviderErrorResponse(
      400,
      error instanceof Error ? error.message : "Invalid Stella model selection",
      request,
    );
  }

  const defaults = getModelConfig(agentType, modelAudience);
  const serverModelConfig = {
    model: resolvedModel,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
  };
  const tokenEstimate = estimateRequestTokens(requestJson);
  const isStreaming = requestJson.stream === true;

  console.log(`[stella-provider] agent=${agentType} | resolvedModel=${resolvedModel}`);

  if (isStreaming) {
    return await createStreamingRuntimeResponse({
      request,
      ctx,
      ownerId,
      agentType,
      modelId: resolvedModel,
      tokenEstimate,
      requestBody: requestJson,
      serverModelConfig,
    });
  }

  const startedAt = Date.now();
  try {
    const message = await completeManagedChat({
      config: serverModelConfig,
      context: buildContextFromChatMessages(requestJson.messages, requestJson.tools),
      request: buildManagedRuntimeRequest(requestJson, request.signal),
    });

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage || "Stella completion failed");
    }

    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId,
      agentType,
      model: resolvedModel,
      durationMs: Date.now() - startedAt,
      success: true,
      ...toManagedBillingUsage(message, tokenEstimate),
    });

    return jsonResponse(
      buildChatCompletionResponse({
        id: `chatcmpl_${startedAt}`,
        created: Math.floor(startedAt / 1000),
        model: resolvedModel,
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
});

export { corsPreflightHandler as stellaProviderOptions };
