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
import { getClientAddressKey } from "./lib/http_utils";
import { parseJsonObject, asNonEmptyString, withoutTrailingSlash } from "./lib/json";
import { getCorsHeaders, withCors, errorResponse, jsonResponse } from "./http_shared/cors";
import { getAnonDeviceId, isAnonDeviceHashSaltMissingError, logMissingSaltOnce } from "./http_shared/anon_device";
import { resolveByokApiKey, resolvePlatformApiKey } from "./lib/provider_keys";

/** Convenience wrapper: extracts origin from request and delegates to the standard withCors. */
function withProxyCors(response: Response, request: Request): Response {
  return withCors(response, request.headers.get("origin"));
}

/** Convenience wrapper: JSON response with CORS extracted from request. */
function proxyJsonResponse(data: unknown, status: number, request: Request): Response {
  return jsonResponse(data, status, request.headers.get("origin"));
}

/** Convenience wrapper: error response with CORS extracted from request. */
function proxyErrorResponse(status: number, message: string, request: Request): Response {
  return errorResponse(status, message, request.headers.get("origin"));
}

const MAX_ANON_REQUESTS = 50_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

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

  // Try device ID — delegate to the shared validator for consistent length/format checks
  const deviceId = getAnonDeviceId(request);
  if (deviceId) {
    return { type: "device", deviceId };
  }

  return { type: "none" };
}


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
    logMissingSaltOnce("ai-proxy");
    return false;
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
    return proxyErrorResponse(429, "Rate limit exceeded. Please create an account for continued access.", request);
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
    return proxyErrorResponse(401, "Unauthorized", request);
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
    return proxyErrorResponse(400, "Invalid JSON", request);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return proxyErrorResponse(400, "messages array is required", request);
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return proxyErrorResponse(429, "Rate limit exceeded. Please create an account for continued access.", request);
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

      return withProxyCors(result.toUIMessageStreamResponse(), request);
    } else {
      // Non-streaming response
      const result = await generateText({
        model,
        system: body.system,
        messages: body.messages as Array<{ role: "user" | "assistant"; content: string }>,
        maxOutputTokens: body.maxOutputTokens || defaults.maxOutputTokens,
        temperature: body.temperature ?? defaults.temperature,
      });

      return proxyJsonResponse({ text: result.text, usage: result.usage }, 200, request);
    }
  } catch (error) {
    console.error("[ai-proxy] Chat error:", error);
    return proxyErrorResponse(500, "An internal error occurred", request);
  }
});

// ─── Embed endpoint ──────────────────────────────────────────────────────────

export const proxyEmbed = httpAction(async (ctx, request) => {
  const auth = await resolveAuth(ctx, request);
  if (auth.type === "none") {
    return proxyErrorResponse(401, "Unauthorized", request);
  }

  let body: { text: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return proxyErrorResponse(400, "Invalid JSON", request);
  }

  if (!body.text) {
    return proxyErrorResponse(400, "text is required", request);
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return proxyErrorResponse(429, "Rate limit exceeded", request);
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

    return proxyJsonResponse({ embedding: result.embedding }, 200, request);
  } catch (error) {
    console.error("[ai-proxy] Embed error:", error);
    return proxyErrorResponse(500, "An internal error occurred", request);
  }
});

// ─── Search endpoint (server-side API key) ───────────────────────────────────

export const proxySearch = httpAction(async (ctx, request) => {
  const auth = await resolveAuth(ctx, request);
  if (auth.type === "none") {
    return proxyErrorResponse(401, "Unauthorized", request);
  }

  let body: { query: string; maxResults?: number };
  try {
    body = await request.json();
  } catch {
    return proxyErrorResponse(400, "Invalid JSON", request);
  }

  if (!body.query) {
    return proxyErrorResponse(400, "query is required", request);
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return proxyErrorResponse(429, "Rate limit exceeded. Please create an account for continued access.", request);
    }
  } else if (auth.type === "jwt") {
    const rateLimitResponse = await consumeAnonJwtRateLimit(ctx, auth, request);
    if (rateLimitResponse) return rateLimitResponse;
  }

  // Web search requires server-side API key (Brave, Tavily, etc.)
  const searchApiKey = process.env.SEARCH_API_KEY;

  if (!searchApiKey) {
    return proxyErrorResponse(501, "Search not configured on server", request);
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
    return proxyJsonResponse(data, 200, request);
  } catch (error) {
    console.error("[ai-proxy] Search error:", error);
    return proxyErrorResponse(500, "An internal error occurred", request);
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
//   X-Provider: anthropic|openai|google|openrouter|azure|azure-cognitive-services|cloudflare-workers-ai|vercel|zenmux|cerebras|kilo|cloudflare-ai-gateway|amazon-bedrock|google-vertex|google-vertex-anthropic|gitlab|github-copilot|github-copilot-enterprise|sap-ai-core|opencode
//   X-Original-Path: /v1/messages (the provider-specific path suffix)
//   Body: raw provider request
//
// Server:
//   1. Validates proxy token
//   2. Looks up upstream from provider allowlist
//   3. Resolves API key via BYOK chain (user key → OpenRouter → platform gateway)
//   4. Forwards request to upstream with real credentials
//   5. Pipes response body directly
//   6. Post-hoc usage logging (best-effort)

function googleVertexProject(apiKey?: string): string | null {
  const parsed = apiKey ? parseJsonObject(apiKey) : null;
  return (
    process.env.GOOGLE_VERTEX_PROJECT?.trim() ||
    asNonEmptyString(parsed?.project_id) ||
    null
  );
}

function googleVertexLocation(defaultLocation: string): string {
  return process.env.GOOGLE_VERTEX_LOCATION?.trim() || defaultLocation;
}


function extractSapAiCoreBaseUrlFromServiceKey(parsed: Record<string, unknown>): string | null {
  const serviceUrls =
    parsed.serviceurls && typeof parsed.serviceurls === "object"
      ? (parsed.serviceurls as Record<string, unknown>)
      : null;
  const urls =
    parsed.urls && typeof parsed.urls === "object"
      ? (parsed.urls as Record<string, unknown>)
      : null;

  const candidates = [
    asNonEmptyString(parsed.apiUrl),
    asNonEmptyString(parsed.baseUrl),
    asNonEmptyString(parsed.AI_API_URL),
    asNonEmptyString(serviceUrls?.AI_API_URL),
    asNonEmptyString(serviceUrls?.apiUrl),
    asNonEmptyString(urls?.AI_API_URL),
    asNonEmptyString(urls?.apiUrl),
  ];

  const found = candidates.find((v) => typeof v === "string");
  return found ? withoutTrailingSlash(found) : null;
}

/** Hard-bound upstream allowlist — client CANNOT influence destination */
const STATIC_PROVIDER_UPSTREAMS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api",
  vercel: "https://ai-gateway.vercel.sh/v1",
  zenmux: "https://zenmux.ai/api/anthropic/v1",
  cerebras: "https://api.cerebras.ai/v1",
  kilo: "https://api.kilo.ai/api/gateway",
  "github-copilot": "https://api.githubcopilot.com",
  "github-copilot-enterprise": "https://api.githubcopilot.com",
  opencode: "https://opencode.ai/zen/v1",
  inception: "https://api.inceptionlabs.ai",
};

const DYNAMIC_PROVIDER_IDS = new Set([
  "azure",
  "azure-cognitive-services",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "amazon-bedrock",
  "google-vertex",
  "google-vertex-anthropic",
  "gitlab",
  "sap-ai-core",
]);

function isSupportedProvider(provider: string): boolean {
  return provider in STATIC_PROVIDER_UPSTREAMS || DYNAMIC_PROVIDER_IDS.has(provider);
}

function resolveProviderUpstream(provider: string, apiKey?: string): string | null {
  const staticUpstream = STATIC_PROVIDER_UPSTREAMS[provider];
  if (staticUpstream) return staticUpstream;

  if (provider === "azure") {
    const resourceName = process.env.AZURE_RESOURCE_NAME?.trim();
    if (!resourceName) return null;
    return `https://${resourceName}.openai.azure.com/openai/v1`;
  }

  if (provider === "azure-cognitive-services") {
    const resourceName = process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME?.trim();
    if (!resourceName) return null;
    return `https://${resourceName}.cognitiveservices.azure.com/openai/v1`;
  }

  if (provider === "cloudflare-workers-ai") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    if (!accountId) return null;
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  }

  if (provider === "cloudflare-ai-gateway") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID?.trim();
    if (!accountId || !gatewayId) return null;
    return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
  }

  if (provider === "amazon-bedrock") {
    const parsed = apiKey ? parseJsonObject(apiKey) : null;
    const region =
      asNonEmptyString(parsed?.region) ??
      asNonEmptyString(parsed?.aws_region) ??
      process.env.AWS_REGION?.trim() ??
      "us-east-1";
    return `https://bedrock-runtime.${region}.amazonaws.com`;
  }

  if (provider === "google-vertex" || provider === "google-vertex-anthropic") {
    const project = googleVertexProject(apiKey);
    if (!project) return null;
    const location = googleVertexLocation(provider === "google-vertex" ? "us-central1" : "global");
    const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    return `https://${endpoint}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
  }

  if (provider === "gitlab") {
    return withoutTrailingSlash(process.env.GITLAB_INSTANCE_URL?.trim() || "https://gitlab.com");
  }

  if (provider === "sap-ai-core") {
    const explicitBase = process.env.SAP_AI_CORE_BASE_URL?.trim();
    if (explicitBase) return withoutTrailingSlash(explicitBase);
    if (!apiKey) return null;
    const parsed = parseJsonObject(apiKey);
    if (!parsed) return null;
    return extractSapAiCoreBaseUrlFromServiceKey(parsed);
  }

  return null;
}

/** Headers that should NOT be forwarded to the upstream */
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "x-provider",
  "x-original-path",
  "x-model-id",
  "x-agent-type",
  "connection",
  "transfer-encoding",
  "content-length",
]);

/** Build upstream-specific auth headers */
async function buildUpstreamAuthHeaders(
  ctx: ActionCtx,
  provider: string,
  apiKey: string,
): Promise<Record<string, string>> {
  switch (provider) {
    case "anthropic":
    case "zenmux":
      return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
    case "azure":
    case "azure-cognitive-services":
      return {
        "api-key": apiKey,
      };
    case "openai":
    case "openrouter":
    case "cloudflare-workers-ai":
    case "cloudflare-ai-gateway":
    case "vercel":
    case "amazon-bedrock":
    case "gitlab":
    case "github-copilot":
    case "github-copilot-enterprise":
    case "opencode":
    case "inception":
      return {
        Authorization: `Bearer ${apiKey}`,
      };
    case "cerebras":
      return {
        Authorization: `Bearer ${apiKey}`,
        "X-Cerebras-3rd-Party-Integration": "stella",
      };
    case "kilo":
      return {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://stella.app/",
        "X-Title": "stella",
      };
    case "google":
      return {
        "x-goog-api-key": apiKey,
      };
    case "google-vertex":
    case "google-vertex-anthropic":
    case "sap-ai-core": {
      // Delegate to Node.js runtime for auth resolution (GoogleAuth, SAP OAuth)
      const headers = await ctx.runAction(internal.ai_proxy_node.resolveNodeAuthHeaders, {
        provider,
        apiKey,
      });
      return headers as Record<string, string>;
    }
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
  // Only allow URL-safe characters used by provider REST paths.
  if (!/^[a-zA-Z0-9/_\-.\?&=%:+,]+$/.test(pathSuffix)) return null;
  return pathSuffix;
}

export const llmProxy = httpAction(async (ctx, request) => {
  // 1. Authenticate via Convex JWT
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return proxyErrorResponse(401, "Unauthorized", request);
  }

  const ownerId = identity.subject;
  const isAnonymous = (identity as Record<string, unknown>).isAnonymous === true;
  const agentType = request.headers.get("X-Agent-Type")?.trim() || "orchestrator";

  // 2. Parse provider and path from headers.
  // Unknown providers are routed through OpenRouter using the model string.
  const requestedProvider = request.headers.get("X-Provider")?.trim()?.toLowerCase();
  if (!requestedProvider) {
    return proxyErrorResponse(400, "Missing X-Provider header", request);
  }
  const provider = isSupportedProvider(requestedProvider)
    ? requestedProvider
    : "openrouter";

  const url = new URL(request.url);
  const originalPath = request.headers.get("X-Original-Path")?.trim() || url.pathname.replace(/^\/api\/ai\/llm-proxy/, "");
  if (!originalPath) {
    return proxyErrorResponse(400, "Missing X-Original-Path header", request);
  }

  const sanitizedPath = sanitizePathSuffix(originalPath);
  if (!sanitizedPath) {
    return proxyErrorResponse(400, "Invalid path", request);
  }

  // 3. Rate limit check
  if (isAnonymous) {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      `anon-jwt:${ownerId}`,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return proxyErrorResponse(429, "Rate limit exceeded. Please create an account for continued access.", request);
    }
  } else {
    const rateCheck = await ctx.runMutation(internal.ai_proxy_data.checkProxyRateLimit, {
      ownerId,
    });

    if (!rateCheck.allowed) {
      const response = proxyErrorResponse(429, "Rate limit exceeded", request);
      response.headers.set("Retry-After", String(Math.ceil((rateCheck.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS) / 1000)));
      return response;
    }
  }

  // 4. Resolve API key via shared BYOK chain
  //    X-Model-Id header carries the full model string (e.g. "anthropic/claude-opus-4.6")
  const modelId =
    request.headers.get("X-Model-Id")?.trim() || `${requestedProvider}/unknown`;
  let apiKey: string | null = null;

  // Try user's BYOK keys (direct provider → OpenRouter)
  const byok = await resolveByokApiKey(ctx, ownerId, requestedProvider);
  if (byok) {
    if (byok.source === "openrouter") {
      // Redirect to OpenRouter upstream
      const upstreamUrl = `${STATIC_PROVIDER_UPSTREAMS.openrouter}${sanitizedPath}`;
      return await forwardRequest(ctx, request, { url: upstreamUrl, provider: "openrouter", apiKey: byok.apiKey }, { ownerId, agentType, modelId }, { isGateway: true });
    }
    apiKey = byok.apiKey;
  }

  // Fall back to platform key from env
  if (!apiKey) {
    apiKey = resolvePlatformApiKey(provider);
  }

  if (!apiKey) {
    // Last resort: route through Vercel AI Gateway using the platform key.
    const gatewayKey = process.env.AI_GATEWAY_API_KEY;
    if (gatewayKey) {
      const gatewayBase = STATIC_PROVIDER_UPSTREAMS.vercel.replace(/\/v1$/, "");
      const gatewayUpstream = `${gatewayBase}${sanitizedPath}`;
      return await forwardRequest(ctx, request, { url: gatewayUpstream, provider: "vercel", apiKey: gatewayKey }, { ownerId, agentType, modelId }, { isGateway: true });
    }
    return proxyErrorResponse(503, "No API key available for provider", request);
  }

  // 5. Forward to upstream
  const upstreamBase = resolveProviderUpstream(provider, apiKey);
  if (!upstreamBase) {
    return proxyErrorResponse(503, "Provider is not configured", request);
  }
  const upstreamUrl = `${upstreamBase}${sanitizedPath}`;

  return await forwardRequest(ctx, request, { url: upstreamUrl, provider, apiKey }, { ownerId, agentType, modelId });
});

async function forwardRequest(
  ctx: ActionCtx,
  request: Request,
  upstream: { url: string; provider: string; apiKey: string },
  usage: { ownerId: string; agentType: string; modelId: string },
  options?: { isGateway?: boolean },
): Promise<Response> {
  // Build forwarded headers
  const forwardHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  });

  // Replace auth headers with real credentials
  const authHeaders = await buildUpstreamAuthHeaders(ctx, upstream.provider, upstream.apiKey);
  // Remove any existing auth headers the client might have sent
  delete forwardHeaders["authorization"];
  delete forwardHeaders["Authorization"];
  delete forwardHeaders["x-api-key"];
  delete forwardHeaders["api-key"];
  delete forwardHeaders["x-goog-api-key"];
  Object.assign(forwardHeaders, authHeaders);

  // For direct provider requests (not gateway), the client sends
  // prefixed model IDs like "anthropic/claude-sonnet-4-6" for gateway
  // compatibility. Strip the prefix so direct providers receive bare IDs.
  let body: BodyInit | null = request.body;
  if (!options?.isGateway && request.body) {
    try {
      const raw = await request.text();
      const parsed = JSON.parse(raw);
      if (typeof parsed.model === "string" && parsed.model.includes("/")) {
        parsed.model = parsed.model.split("/").slice(1).join("/");
      }
      body = JSON.stringify(parsed);
    } catch {
      // Body is not JSON or already consumed — forward as-is
      body = request.body;
    }
  }

  const startMs = Date.now();

  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: request.method,
      headers: forwardHeaders,
      body,
    });

    const durationMs = Date.now() - startMs;
    const isStreaming = upstreamResponse.headers.get("content-type")?.includes("text/event-stream");

    // Build response headers (strip upstream auth-related headers, inject CORS)
    const origin = request.headers.get("origin");
    const corsHeaders = getCorsHeaders(origin);
    const responseHeaders: Record<string, string> = { ...corsHeaders };
    upstreamResponse.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower !== "set-cookie" &&
        lower !== "www-authenticate" &&
        !lower.startsWith("access-control-")
      ) {
        responseHeaders[key] = value;
      }
    });

    if (isStreaming) {
      // Pipe streaming response directly — post-hoc usage logging
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
        ownerId: usage.ownerId,
        agentType: usage.agentType,
        model: usage.modelId,
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
      ownerId: usage.ownerId,
      agentType: usage.agentType,
      model: usage.modelId,
      durationMs,
      success: false,
      estimateFromRequest: true,
    });

    return proxyErrorResponse(502, "Failed to reach upstream provider", request);
  }
}
