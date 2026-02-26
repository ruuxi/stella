/**
 * Stella AI Proxy — thin proxy for LLM and embedding requests.
 *
 * Two proxy modes:
 * 1. proxyChat/proxyEmbed/proxySearch — high-level AI SDK proxy (existing)
 *    Auth: Bearer JWT or X-Device-ID (rate-limited)
 *
 * 2. llmProxy — transparent reverse proxy for local agent runtime
 *    Auth: X-Proxy-Token (short-lived, proxy-scoped)
 *    Pipes raw request/response to provider upstream
 *    BYOK support via resolveModelViaByokChain
 *
 * The proxy stores ZERO conversation content. It only forwards requests
 * to AI providers and logs token usage for billing.
 */

import type { ActionCtx } from "./_generated/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { streamText, generateText, createGateway, embed } from "ai";
import { getModelConfig } from "./agent/model";

const MAX_ANON_REQUESTS = 10;
const ANON_DEVICE_HASH_SALT_MISSING_MESSAGE = "Missing ANON_DEVICE_ID_HASH_SALT";
let didLogMissingAnonDeviceSaltForProxy = false;
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128;
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/;

type ProxyAuth =
  | { type: "jwt"; userId: string; isAnonymous: boolean }
  | { type: "device"; deviceId: string }
  | { type: "none" };

async function resolveAuth(ctx: ActionCtx, request: Request): Promise<ProxyAuth> {
  // Try JWT first
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    const isAnonymous =
      (identity as Record<string, unknown>).isAnonymous === true;
    return { type: "jwt", userId: identity.subject, isAnonymous };
  }

  // Try device ID
  const deviceId = request.headers.get("X-Device-ID")?.trim();
  if (deviceId && deviceId.length > 0 && deviceId.length < 256) {
    return { type: "device", deviceId };
  }

  return { type: "none" };
}

const normalizeClientAddressKey = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CLIENT_ADDRESS_KEY_LENGTH ||
    !CLIENT_ADDRESS_KEY_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};

const getClientAddressKey = (request: Request): string | null => {
  const cloudflareIp = normalizeClientAddressKey(request.headers.get("cf-connecting-ip"));
  if (cloudflareIp) return cloudflareIp;

  const realIp = normalizeClientAddressKey(request.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (!forwardedFor) return null;
  const firstHop = forwardedFor.split(",")[0] ?? "";
  return normalizeClientAddressKey(firstHop);
};

const isAnonDeviceHashSaltMissingError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(ANON_DEVICE_HASH_SALT_MISSING_MESSAGE);

async function consumeDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runMutation(internal.ai_proxy_data.consumeDeviceAllowance, {
      deviceId,
      maxRequests: MAX_ANON_REQUESTS,
      clientAddressKey: clientAddressKey ?? undefined,
    });
    return usage.allowed;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    if (!didLogMissingAnonDeviceSaltForProxy) {
      didLogMissingAnonDeviceSaltForProxy = true;
      console.warn(
        "[ai-proxy] Missing ANON_DEVICE_ID_HASH_SALT; anonymous rate limiting is disabled until configured.",
      );
    }
    return true;
  }
}

async function consumeAnonJwtRateLimit(
  ctx: ActionCtx,
  auth: Extract<ProxyAuth, { type: "jwt" }>,
  request: Request,
): Promise<Response | null> {
  if (!auth.isAnonymous) return null;
  const allowed = await consumeDeviceRateLimit(
    ctx,
    `anon-jwt:${auth.userId}`,
    getClientAddressKey(request),
  );
  if (!allowed) {
    return new Response(
      JSON.stringify({
        error:
          "Rate limit exceeded. Please create an account for continued access.",
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

function getGateway() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("Missing AI_GATEWAY_API_KEY");
  return createGateway({ apiKey });
}

// ─── Proxy endpoint: Forward LLM request ─────────────────────────────────────

export const proxyChat = httpAction(async (ctx, request) => {
  const auth = await resolveAuth(ctx, request);
  if (auth.type === "none") {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    agentType?: string;
    system?: string;
    maxOutputTokens?: number;
    temperature?: number;
    stream?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return new Response("messages array is required", { status: 400 });
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please create an account for continued access." }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }
  } else if (auth.type === "jwt") {
    const rateLimitResponse = await consumeAnonJwtRateLimit(ctx, auth, request);
    if (rateLimitResponse) return rateLimitResponse;
  }

  const gateway = getGateway();
  const agentType = body.agentType || "general";
  const defaults = getModelConfig(agentType);
  const modelString = body.model || defaults.model;
  const model = gateway(modelString);

  try {
    if (body.stream !== false) {
      // Streaming response
      const result = streamText({
        model,
        system: body.system,
        messages: body.messages as Array<{ role: "user" | "assistant"; content: string }>,
        maxOutputTokens: body.maxOutputTokens || defaults.maxOutputTokens,
        temperature: body.temperature ?? defaults.temperature,
      });

      return result.toUIMessageStreamResponse();
    } else {
      // Non-streaming response
      const result = await generateText({
        model,
        system: body.system,
        messages: body.messages as Array<{ role: "user" | "assistant"; content: string }>,
        maxOutputTokens: body.maxOutputTokens || defaults.maxOutputTokens,
        temperature: body.temperature ?? defaults.temperature,
      });

      return new Response(
        JSON.stringify({
          text: result.text,
          usage: result.usage,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  } catch (error) {
    console.error("[ai-proxy] Chat error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ─── Embed endpoint ──────────────────────────────────────────────────────────

export const proxyEmbed = httpAction(async (ctx, request) => {
  const auth = await resolveAuth(ctx, request);
  if (auth.type === "none") {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { text: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.text) {
    return new Response("text is required", { status: 400 });
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }
  } else if (auth.type === "jwt") {
    const rateLimitResponse = await consumeAnonJwtRateLimit(ctx, auth, request);
    if (rateLimitResponse) return rateLimitResponse;
  }

  const gateway = getGateway();
  const embeddingConfig = getModelConfig("ai_proxy_embedding");

  try {
    const result = await embed({
      model: gateway.textEmbeddingModel(body.model || embeddingConfig.model),
      value: body.text,
    });

    return new Response(
      JSON.stringify({ embedding: result.embedding }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[ai-proxy] Embed error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ─── Search endpoint (server-side API key) ───────────────────────────────────

export const proxySearch = httpAction(async (ctx, request) => {
  const auth = await resolveAuth(ctx, request);
  if (auth.type === "none") {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: { query: string; maxResults?: number };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.query) {
    return new Response("query is required", { status: 400 });
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded. Please create an account for continued access." }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }
  } else if (auth.type === "jwt") {
    const rateLimitResponse = await consumeAnonJwtRateLimit(ctx, auth, request);
    if (rateLimitResponse) return rateLimitResponse;
  }

  // Web search requires server-side API key (Brave, Tavily, etc.)
  const searchApiKey = process.env.SEARCH_API_KEY;

  if (!searchApiKey) {
    return new Response(
      JSON.stringify({ error: "Search not configured on server" }),
      { status: 501, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    // Use Tavily as default search provider
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: searchApiKey,
        query: body.query,
        max_results: body.maxResults || 5,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Search API returned ${response.status}`);
    }

    const data = await response.json();
    return new Response(
      JSON.stringify(data),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[ai-proxy] Search error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ─── Transparent LLM Reverse Proxy ───────────────────────────────────────────
//
// Used by the local agent runtime in Electron. Authenticates via proxy-scoped
// token (X-Proxy-Token), resolves API keys via BYOK chain, forwards raw HTTP
// to provider upstream. Streams response body directly without parsing.
//
// Client sends:
//   POST /api/ai/llm-proxy
//   X-Proxy-Token: <token>
//   X-Provider: anthropic|openai|google|openrouter|gateway
//   X-Original-Path: /v1/messages (the provider-specific path suffix)
//   Body: raw provider request
//
// Server:
//   1. Validates proxy token
//   2. Looks up upstream from PROVIDER_UPSTREAMS
//   3. Resolves API key via BYOK chain (user key → OpenRouter → platform gateway)
//   4. Forwards request to upstream with real credentials
//   5. Pipes response body directly
//   6. Post-hoc usage logging (best-effort)

/** Hard-bound upstream allowlist — client CANNOT influence destination */
const PROVIDER_UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api",
};

/** Headers that should NOT be forwarded to the upstream */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "x-proxy-token",
  "x-provider",
  "x-original-path",
  "x-model-id",
  "connection",
  "transfer-encoding",
]);

/** Build upstream-specific auth headers */
function buildUpstreamAuthHeaders(
  provider: string,
  apiKey: string,
): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "openai":
    case "openrouter":
      return {
        Authorization: `Bearer ${apiKey}`,
      };
    case "google":
      return {
        "x-goog-api-key": apiKey,
      };
    default:
      return {
        Authorization: `Bearer ${apiKey}`,
      };
  }
}

/** Sanitize path suffix to prevent path traversal */
function sanitizePathSuffix(pathSuffix: string): string | null {
  // Must start with /
  if (!pathSuffix.startsWith("/")) return null;
  // Reject path traversal
  if (pathSuffix.includes("..")) return null;
  // Only allow alphanumeric, slashes, hyphens, underscores, dots, query params
  if (!/^[a-zA-Z0-9/_\-.\?&=%]+$/.test(pathSuffix)) return null;
  return pathSuffix;
}

export const llmProxy = httpAction(async (ctx, request) => {
  // 1. Authenticate via proxy token
  const proxyToken = request.headers.get("X-Proxy-Token")?.trim();
  if (!proxyToken) {
    return new Response(
      JSON.stringify({ error: "Missing X-Proxy-Token header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const tokenResult = await ctx.runQuery(internal.ai_proxy_data.validateProxyToken, {
    token: proxyToken,
  });

  if (!tokenResult.valid) {
    return new Response(
      JSON.stringify({ error: `Authentication failed: ${tokenResult.reason}` }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const { ownerId, agentType } = tokenResult;

  // 2. Parse provider and path from headers.
  // Unknown providers are routed through OpenRouter using the model string.
  const requestedProvider = request.headers.get("X-Provider")?.trim()?.toLowerCase();
  if (!requestedProvider) {
    return new Response(
      JSON.stringify({
        error: "Missing X-Provider header",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const provider = requestedProvider in PROVIDER_UPSTREAMS
    ? requestedProvider
    : "openrouter";

  const originalPath = request.headers.get("X-Original-Path")?.trim();
  if (!originalPath) {
    return new Response(
      JSON.stringify({ error: "Missing X-Original-Path header" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const sanitizedPath = sanitizePathSuffix(originalPath);
  if (!sanitizedPath) {
    return new Response(
      JSON.stringify({ error: "Invalid path" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // 3. Rate limit check
  const rateCheck = await ctx.runMutation(internal.ai_proxy_data.checkProxyRateLimit, {
    ownerId,
  });

  if (!rateCheck.allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)),
        },
      },
    );
  }

  // 4. Resolve API key via BYOK chain
  //    X-Model-Id header carries the full model string (e.g. "anthropic/claude-opus-4.6")
  //    for BYOK key resolution
  const modelId =
    request.headers.get("X-Model-Id")?.trim() || `${requestedProvider}/unknown`;
  let apiKey: string | null = null;
  const canUseDirectProviderKey = requestedProvider in PROVIDER_UPSTREAMS;

  // Try user's own key first
  if (canUseDirectProviderKey) {
    try {
      const userKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: `llm:${requestedProvider}`,
      });
      if (userKey) {
        apiKey = userKey;
      }
    } catch {
      // No user key — fall through
    }
  }

  // Try OpenRouter key as fallback
  if (!apiKey) {
    try {
      const openrouterKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: "llm:openrouter",
      });
      if (openrouterKey) {
        apiKey = openrouterKey;
        // Redirect to OpenRouter upstream
        const upstreamUrl = `${PROVIDER_UPSTREAMS.openrouter}${sanitizedPath}`;
        return await forwardRequest(ctx, request, upstreamUrl, "openrouter", openrouterKey, ownerId, agentType, modelId);
      }
    } catch {
      // No OpenRouter key
    }
  }

  // Fall back to platform key from env
  if (!apiKey) {
    const envKeyMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_AI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    const envKey = envKeyMap[provider];
    if (envKey) {
      apiKey = process.env[envKey] ?? null;
    }
  }

  if (!apiKey) {
    // Last resort: use AI gateway
    const gatewayKey = process.env.AI_GATEWAY_API_KEY;
    if (gatewayKey) {
      // Use gateway — rewrite to gateway URL
      // The gateway handles provider routing via the model string
      return new Response(
        JSON.stringify({ error: "Gateway passthrough not supported for raw proxy. Configure a provider API key." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "No API key available for provider" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // 5. Forward to upstream
  const upstreamBase = PROVIDER_UPSTREAMS[provider]!;
  const upstreamUrl = `${upstreamBase}${sanitizedPath}`;

  return await forwardRequest(ctx, request, upstreamUrl, provider, apiKey, ownerId, agentType, modelId);
});

async function forwardRequest(
  ctx: ActionCtx,
  request: Request,
  upstreamUrl: string,
  provider: string,
  apiKey: string,
  ownerId: string,
  agentType: string,
  modelId: string,
): Promise<Response> {
  // Build forwarded headers
  const forwardHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  });

  // Replace auth headers with real credentials
  const authHeaders = buildUpstreamAuthHeaders(provider, apiKey);
  // Remove any existing auth headers the client might have sent
  delete forwardHeaders["authorization"];
  delete forwardHeaders["x-api-key"];
  delete forwardHeaders["x-goog-api-key"];
  Object.assign(forwardHeaders, authHeaders);

  const startMs = Date.now();

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.body,
    });

    const durationMs = Date.now() - startMs;
    const isStreaming = upstreamResponse.headers.get("content-type")?.includes("text/event-stream");

    // Build response headers (strip upstream auth-related headers)
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower !== "set-cookie" && lower !== "www-authenticate") {
        responseHeaders[key] = value;
      }
    });

    if (isStreaming) {
      // Pipe streaming response directly — post-hoc usage logging
      void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
        ownerId,
        agentType,
        model: modelId,
        durationMs,
        success: upstreamResponse.ok,
        estimateFromRequest: true,
      });

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    } else {
      // Non-streaming: read body, extract usage, forward
      const responseBody = await upstreamResponse.text();

      // Best-effort usage extraction
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        const parsed = JSON.parse(responseBody);
        if (parsed.usage) {
          inputTokens = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
          outputTokens = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
        }
      } catch {
        // Not JSON or no usage field
      }

      void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
        ownerId,
        agentType,
        model: modelId,
        durationMs,
        success: upstreamResponse.ok,
        inputTokens,
        outputTokens,
        estimateFromRequest: !inputTokens && !outputTokens,
      });

      return new Response(responseBody, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    console.error("[llm-proxy] Forward error:", error);
    const durationMs = Date.now() - startMs;

    void ctx.scheduler.runAfter(0, internal.agent.hooks.logProxyUsage, {
      ownerId,
      agentType,
      model: modelId,
      durationMs,
      success: false,
      estimateFromRequest: true,
    });

    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
