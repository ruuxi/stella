/**
 * Stella managed execution endpoint.
 *
 * This endpoint is only used for Stella-managed requests when the desktop app
 * does not have a matching local PI provider key. It authenticates the user via
 * the normal Convex bearer token, resolves the managed model server-side, then
 * forwards the request to the upstream gateway and streams the response back
 * unchanged.
 */

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { AGENT_MODELS, DEFAULT_MODEL } from "./agent/model";
import { getClientAddressKey } from "./lib/http_utils";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import { errorResponse, getCorsHeaders } from "./http_shared/cors";

const MAX_ANON_REQUESTS = 50_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MANAGED_CHAT_COMPLETIONS_PATH = "/chat/completions";
// 1 = Vercel AI Gateway, 2 = OpenRouter
const GATEWAY = 2;

const GATEWAY_BASE_URL =
  GATEWAY === 2
    ? "https://openrouter.ai/api/v1"
    : (process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1");

function managedExecutionErrorResponse(
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
    logMissingSaltOnce("managed-execution");
    return false;
  }
}

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
]);

export const managedExecution = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return managedExecutionErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.subject;
  const isAnonymous = (identity as Record<string, unknown>).isAnonymous === true;

  const url = new URL(request.url);
  if (!url.pathname.endsWith(MANAGED_CHAT_COMPLETIONS_PATH)) {
    return managedExecutionErrorResponse(404, "Managed AI path not found", request);
  }

  if (isAnonymous) {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      `anon-jwt:${ownerId}`,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return managedExecutionErrorResponse(
        429,
        "Rate limit exceeded. Please create an account for continued access.",
        request,
      );
    }
  } else {
    const rateCheck = await ctx.runMutation(
      internal.ai_proxy_data.checkProxyRateLimit,
      {
        ownerId,
      },
    );

    if (!rateCheck.allowed) {
      const response = managedExecutionErrorResponse(429, "Rate limit exceeded", request);
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

  const gatewayKey = (GATEWAY === 2 ? process.env.OPENROUTER_API_KEY : process.env.AI_GATEWAY_API_KEY)?.trim();
  if (!gatewayKey) {
    return managedExecutionErrorResponse(
      503,
      "Managed AI Gateway is not configured",
      request,
    );
  }

  const requestJson = await parseManagedRequest(request);
  if (!requestJson) {
    return managedExecutionErrorResponse(400, "Managed AI request body must be valid JSON", request);
  }

  const agentType =
    typeof requestJson.agentType === "string" && requestJson.agentType.trim().length > 0
      ? requestJson.agentType.trim()
      : "general";
  const serverModelConfig = await resolveManagedModelConfig(ctx, ownerId, agentType);
  const modelId = serverModelConfig.model;
  const gatewayUpstream = `${GATEWAY_BASE_URL}${MANAGED_CHAT_COMPLETIONS_PATH}`;

  console.log(
    `[managed-execution] agent=${agentType} | resolvedModel=${modelId} | fallback=${serverModelConfig.fallback || "(none)"}`,
  );

  return await forwardRequest(
    ctx,
    request,
    { url: gatewayUpstream, apiKey: gatewayKey },
    { ownerId, agentType, modelId },
    buildUpstreamBody(requestJson, serverModelConfig),
  );
});

async function parseManagedRequest(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveManagedModelConfig(
  ctx: ActionCtx,
  ownerId: string,
  agentType: string,
): Promise<{ model: string; fallback?: string; providerOptions?: Record<string, Record<string, unknown>> }> {
  const defaults = AGENT_MODELS[agentType] ?? DEFAULT_MODEL;
  let model = defaults.model;
  try {
    const override = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
      ownerId,
      key: `model_config:${agentType}`,
    });
    if (typeof override === "string" && override.trim().length > 0) {
      model = override.trim();
    }
  } catch {
    // Preference lookup is best-effort for managed desktop requests.
  }

  return {
    model,
    fallback: defaults.fallback,
    providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
  };
}

function buildUpstreamBody(
  requestBody: Record<string, unknown>,
  serverModelConfig: { model: string; providerOptions?: Record<string, Record<string, unknown>> },
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

async function forwardRequest(
  ctx: ActionCtx,
  request: Request,
  upstream: { url: string; apiKey: string },
  usage: { ownerId: string; agentType: string; modelId: string },
  requestBody: string,
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
      upstreamResponse.headers.get("content-type")?.includes(
        "text/event-stream",
      ) ?? false;

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
      void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
        ownerId: usage.ownerId,
        agentType: usage.agentType,
        model: usage.modelId,
        durationMs,
        success: upstreamResponse.ok,
        estimateFromRequest: true,
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
        outputTokens =
          parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
      }
    } catch {
      // Compressed or non-JSON — usage tracking will estimate from request.
    }

    void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: upstreamResponse.ok,
      inputTokens,
      outputTokens,
      estimateFromRequest: !inputTokens && !outputTokens,
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
    console.error("[managed-execution] Forward error:", error);
    const durationMs = Date.now() - startMs;

    void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: false,
      estimateFromRequest: true,
    });

    return managedExecutionErrorResponse(
      502,
      "Failed to reach managed AI Gateway",
      request,
    );
  }
}
