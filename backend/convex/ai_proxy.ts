/**
 * Stella managed AI endpoint.
 *
 * This endpoint is only used for Stella-managed requests when the desktop app
 * does not have a matching local PI provider key. It authenticates the user via
 * the normal Convex bearer token, forwards the raw OpenAI-compatible request to
 * Vercel AI Gateway with the platform key, and streams the upstream response
 * back unchanged.
 */

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getClientAddressKey } from "./lib/http_utils";
import { errorResponse, getCorsHeaders } from "./http_shared/cors";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import { AGENT_MODELS, DEFAULT_MODEL } from "./agent/model";

const MAX_ANON_REQUESTS = 50_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const GATEWAY_BASE_URL =
  process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";

/** Convenience wrapper: error response with CORS extracted from request. */
function proxyErrorResponse(
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
    logMissingSaltOnce("ai-proxy");
    return false;
  }
}

/** Headers that should NOT be forwarded to the upstream */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "x-provider",
  "x-model-id",
  "x-agent-type",
  "connection",
  "transfer-encoding",
  "content-length",
]);

/** Sanitize path suffix to prevent path traversal */
function sanitizePathSuffix(pathSuffix: string): string | null {
  if (!pathSuffix.startsWith("/")) return null;
  if (pathSuffix.includes("..")) return null;
  if (!/^[a-zA-Z0-9/_\-.\?&=%:+,]+$/.test(pathSuffix)) return null;
  return pathSuffix;
}

export const managedAi = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return proxyErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.subject;
  const isAnonymous = (identity as Record<string, unknown>).isAnonymous === true;
  const agentType =
    request.headers.get("X-Agent-Type")?.trim() || "orchestrator";
  const requestedProvider =
    request.headers.get("X-Provider")?.trim()?.toLowerCase() || "vercel";

  const url = new URL(request.url);
  const originalPath = url.pathname.replace(/^\/api\/ai\/v1/, "");
  if (!originalPath) {
    return proxyErrorResponse(400, "Managed AI path is required", request);
  }

  const sanitizedPath = sanitizePathSuffix(originalPath);
  if (!sanitizedPath) {
    return proxyErrorResponse(400, "Invalid path", request);
  }

  if (isAnonymous) {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      `anon-jwt:${ownerId}`,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return proxyErrorResponse(
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
      const response = proxyErrorResponse(429, "Rate limit exceeded", request);
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

  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!gatewayKey) {
    return proxyErrorResponse(
      503,
      "Managed AI Gateway is not configured",
      request,
    );
  }

  const clientModelId = request.headers.get("X-Model-Id")?.trim() || "";
  const needsServerModel = !clientModelId;
  const serverModelConfig = needsServerModel
    ? (AGENT_MODELS[agentType] ?? DEFAULT_MODEL)
    : null;
  const modelId = clientModelId || serverModelConfig?.model || `${requestedProvider}/unknown`;
  const gatewayUpstream = `${GATEWAY_BASE_URL}${sanitizedPath}`;

  console.log(`[ai-proxy] agent=${agentType} | clientModel=${clientModelId || "(none)"} | serverModel=${serverModelConfig?.model || "(not used)"} | resolvedModel=${modelId} | fallback=${serverModelConfig?.fallback || "(none)"}`);

  return await forwardRequest(
    ctx,
    request,
    { url: gatewayUpstream, apiKey: gatewayKey },
    { ownerId, agentType, modelId },
    serverModelConfig,
  );
});

async function forwardRequest(
  ctx: ActionCtx,
  request: Request,
  upstream: { url: string; apiKey: string },
  usage: { ownerId: string; agentType: string; modelId: string },
  serverModelConfig?: { model: string; fallback?: string; providerOptions?: Record<string, Record<string, unknown>> } | null,
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
  // Prevent upstream from compressing responses — Convex's fetch doesn't
  // auto-decompress, so compressed bytes get corrupted by .text() decoding.
  forwardHeaders["Accept-Encoding"] = "identity";

  // When the frontend didn't specify a model, inject the server-side model
  // config into the request body before forwarding to the gateway.
  let requestBody: BodyInit | null = request.body;
  if (serverModelConfig) {
    try {
      const bodyText = await request.text();
      const bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
      bodyJson.model = serverModelConfig.model;
      if (serverModelConfig.providerOptions) {
        // Merge provider options (e.g. gateway ordering) into the body
        for (const [key, value] of Object.entries(serverModelConfig.providerOptions)) {
          bodyJson[key] = value;
        }
      }
      requestBody = JSON.stringify(bodyJson);
      forwardHeaders["content-type"] = "application/json";
      console.log(`[ai-proxy] injected server model into body | model=${bodyJson.model}`);
    } catch {
      // If body parsing fails, forward as-is
      console.warn("[ai-proxy] failed to parse request body for model injection");
    }
  }

  const startMs = Date.now();

  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: request.method,
      headers: forwardHeaders,
      body: requestBody,
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

    // Read as raw bytes to avoid corrupting compressed responses.
    // upstreamResponse.text() would interpret gzip/br bytes as UTF-8,
    // replacing invalid sequences with U+FFFD.
    const rawBytes = new Uint8Array(await upstreamResponse.arrayBuffer());

    // Try to extract usage stats from the response (best-effort)
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

    // Forward raw bytes with original content-encoding so the client
    // can decompress properly.
    const encoding = upstreamResponse.headers.get("content-encoding");
    if (encoding) {
      responseHeaders["content-encoding"] = encoding;
    }

    return new Response(rawBytes, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("[managed-ai] Forward error:", error);
    const durationMs = Date.now() - startMs;

    void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: false,
      estimateFromRequest: true,
    });

    return proxyErrorResponse(
      502,
      "Failed to reach managed AI Gateway",
      request,
    );
  }
}
