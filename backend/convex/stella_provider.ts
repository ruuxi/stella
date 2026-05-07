/**
 * Stella provider HTTP surface.
 *
 * Stella clients talk to this namespace using `stella/*` model IDs.
 * Stella resolves the actual upstream provider/model server-side.
 *
 * Internals are split into focused modules under `stella_provider/`:
 *
 * - `shared.ts` — types, paths, SSE constants, generic JSON helpers.
 * - `billing.ts` — usage normalization, anonymous-device bookkeeping,
 *   chat-completion response shaping.
 * - `request.ts` — model resolution, token estimation, runtime-request
 *   shaping (OpenAI-compat and native variants), protocol resolution.
 * - `authorization.ts` — auth, audience + rate-limit checks.
 * - `streaming_openai.ts` — `chat.completion.chunk` SSE translator.
 * - `streaming_native.ts` — Pi-style `AssistantMessageEvent` SSE
 *   translator.
 *
 * This file keeps only the public httpAction handlers and the small
 * glue that ties them together. Re-exports are limited to the path
 * constants other Convex modules already imported.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { type ManagedModelAudience } from "./agent/model";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
} from "./http_shared/cors";
import {
  buildContextFromChatMessages,
  buildManagedModel,
  completeManagedChat,
} from "./runtime_ai/managed";
import {
  STELLA_MODEL_CATALOG_UPDATED_AT,
  listStellaCatalogModels,
  listStellaDefaultSelections,
} from "./stella_models";
import { resolveManagedModelAccess } from "./lib/managed_billing";
import {
  buildChatCompletionResponse,
  STELLA_MODELS_RATE_LIMIT,
  STELLA_MODELS_RATE_WINDOW_MS,
  toManagedBillingUsage,
} from "./stella_provider/billing";
import {
  asRecord,
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_RUNTIME_PATH,
  toUpstreamHttpError,
} from "./stella_provider/shared";
import {
  buildManagedRuntimeRequest,
  estimateContextTokens,
  estimateRequestTokens,
  parseNativeContext,
} from "./stella_provider/request";
import { authorizeStellaRequest } from "./stella_provider/authorization";
import { createStreamingRuntimeResponse } from "./stella_provider/streaming_openai";
import { createNativeRuntimeResponse } from "./stella_provider/streaming_native";

export {
  STELLA_API_BASE_PATH,
  STELLA_CHAT_COMPLETIONS_PATH,
  STELLA_RUNTIME_PATH,
  STELLA_MODELS_PATH,
} from "./stella_provider/shared";

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
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
        updatedAt: STELLA_MODEL_CATALOG_UPDATED_AT,
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
