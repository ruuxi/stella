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
  STELLA_DEFAULT_MODEL,
  isStellaModel,
  listStellaCatalogModels,
  resolveStellaModelSelection,
} from "./stella_models";
import { resolveManagedModelAccess } from "./lib/managed_billing";

const MAX_ANON_REQUESTS = 50_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export const STELLA_API_BASE_PATH = "/api/stella/v1";
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/chat/completions`;
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;

type StellaRequestBody = Record<string, unknown>;

type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
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

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
]);

async function parseRequestJson(request: Request): Promise<StellaRequestBody | null> {
  try {
    return (await request.json()) as StellaRequestBody;
  } catch {
    return null;
  }
}

function buildUpstreamBody(
  requestBody: StellaRequestBody,
  serverModelConfig: {
    model: string;
    providerOptions?: Record<string, Record<string, unknown>>;
  },
): string {
  const upstreamBody: Record<string, unknown> = { ...requestBody };
  delete upstreamBody.agentType;
  delete upstreamBody.model;

  if (
    typeof upstreamBody.maxOutputTokens === "number"
    && upstreamBody.max_completion_tokens === undefined
    && upstreamBody.max_tokens === undefined
  ) {
    upstreamBody.max_completion_tokens = upstreamBody.maxOutputTokens;
  }
  delete upstreamBody.maxOutputTokens;

  upstreamBody.model = serverModelConfig.model;
  if (serverModelConfig.providerOptions) {
    for (const [key, value] of Object.entries(serverModelConfig.providerOptions)) {
      upstreamBody[key] = value;
    }
  }

  return JSON.stringify(upstreamBody);
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

async function forwardRequest(
  ctx: ActionCtx,
  request: Request,
  upstream: { url: string; apiKey: string },
  usage: { ownerId: string; agentType: string; modelId: string },
  requestBody: string,
  tokenEstimate: TokenEstimate,
): Promise<Response> {
  const forwardHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  });

  delete forwardHeaders.authorization;
  delete forwardHeaders.Authorization;
  delete forwardHeaders["x-api-key"];
  delete forwardHeaders["api-key"];
  delete forwardHeaders["x-goog-api-key"];
  forwardHeaders.Authorization = `Bearer ${upstream.apiKey}`;
  forwardHeaders["Accept-Encoding"] = "identity";
  forwardHeaders["content-type"] = "application/json";

  const startMs = Date.now();

  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: request.method,
      headers: forwardHeaders,
      body: requestBody as BodyInit,
    });

    const durationMs = Date.now() - startMs;
    const isStreaming =
      upstreamResponse.headers.get("content-type")?.includes("text/event-stream")
      ?? false;

    const origin = request.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin);
    const responseHeaders: Record<string, string> = { ...corsHeaders };
    upstreamResponse.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower !== "set-cookie" &&
        lower !== "www-authenticate" &&
        lower !== "content-encoding" &&
        lower !== "content-length" &&
        !lower.startsWith("access-control-")
      ) {
        responseHeaders[key] = value;
      }
    });

    if (isStreaming) {
      await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
        ownerId: usage.ownerId,
        agentType: usage.agentType,
        model: usage.modelId,
        durationMs,
        success: upstreamResponse.ok,
        inputTokens: tokenEstimate.inputTokens,
        outputTokens: tokenEstimate.outputTokens,
      });

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    const rawBytes = new Uint8Array(await upstreamResponse.arrayBuffer());

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as {
        usage?: {
          input_tokens?: number;
          prompt_tokens?: number;
          output_tokens?: number;
          completion_tokens?: number;
        };
      };
      if (parsed.usage) {
        inputTokens = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
        outputTokens = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
      }
    } catch {
      // Fall back to estimated usage logging for non-JSON responses.
    }

    const billedInputTokens = inputTokens ?? tokenEstimate.inputTokens;
    const billedOutputTokens = outputTokens ?? tokenEstimate.outputTokens;

    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: upstreamResponse.ok,
      inputTokens: billedInputTokens,
      outputTokens: billedOutputTokens,
    });

    const encoding = upstreamResponse.headers.get("content-encoding");
    if (encoding) {
      responseHeaders["content-encoding"] = encoding;
    }

    return new Response(rawBytes, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("[stella-provider] Forward error:", error);
    const durationMs = Date.now() - startMs;

    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: false,
      inputTokens: tokenEstimate.inputTokens,
      outputTokens: tokenEstimate.outputTokens,
    });

    return stellaProviderErrorResponse(
      502,
      "Failed to reach Stella upstream gateway",
      request,
    );
  }
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

  const gatewayKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar]?.trim();
  if (!gatewayKey) {
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
  const gatewayUpstream = `${MANAGED_GATEWAY.baseURL}/chat/completions`;
  const tokenEstimate = estimateRequestTokens(requestJson);

  console.log(`[stella-provider] agent=${agentType} | resolvedModel=${resolvedModel}`);

  return await forwardRequest(
    ctx,
    request,
    { url: gatewayUpstream, apiKey: gatewayKey },
    { ownerId, agentType, modelId: resolvedModel },
    buildUpstreamBody(
      requestJson,
      {
        model: resolvedModel,
        providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
      },
    ),
    tokenEstimate,
  );
});

export { corsPreflightHandler as stellaProviderOptions };
