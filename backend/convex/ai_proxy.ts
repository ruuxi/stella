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

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-ID",
    "Access-Control-Max-Age": "86400",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function withProxyCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const MAX_ANON_REQUESTS = 50000;
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
    return withProxyCors(new Response("Unauthorized", { status: 401 }), request);
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
    return withProxyCors(new Response("Invalid JSON", { status: 400 }), request);
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return withProxyCors(new Response("messages array is required", { status: 400 }), request);
  }

  if (auth.type === "device") {
    const allowed = await consumeDeviceRateLimit(
      ctx,
      auth.deviceId,
      getClientAddressKey(request),
    );
    if (!allowed) {
      return withProxyCors(
        new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please create an account for continued access." }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
        request,
      );
    }
  } else if (auth.type === "jwt") {
    const rateLimitResponse = await consumeAnonJwtRateLimit(ctx, auth, request);
    if (rateLimitResponse) return withProxyCors(rateLimitResponse, request);
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

      return withProxyCors(
        new Response(
          JSON.stringify({
            text: result.text,
            usage: result.usage,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        request,
      );
    }
  } catch (error) {
    console.error("[ai-proxy] Chat error:", error);
    return withProxyCors(
      new Response(
        JSON.stringify({ error: (error as Error).message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
      request,
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

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function googleVertexProject(apiKey?: string): string | null {
  const parsed = apiKey ? parseJsonObject(apiKey) : null;
  return (
    process.env.GOOGLE_VERTEX_PROJECT?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GCP_PROJECT?.trim() ||
    process.env.GCLOUD_PROJECT?.trim() ||
    asNonEmptyString(parsed?.project_id) ||
    asNonEmptyString(parsed?.projectId) ||
    null
  );
}

function googleVertexLocation(defaultLocation: string): string {
  return (
    process.env.GOOGLE_VERTEX_LOCATION?.trim() ||
    process.env.GOOGLE_CLOUD_LOCATION?.trim() ||
    process.env.VERTEX_LOCATION?.trim() ||
    defaultLocation
  );
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
  "x-proxy-token",
  "x-provider",
  "x-original-path",
  "x-model-id",
  "connection",
  "transfer-encoding",
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
  const provider = isSupportedProvider(requestedProvider)
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
  const canUseDirectProviderKey = isSupportedProvider(requestedProvider);

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
        const upstreamUrl = `${STATIC_PROVIDER_UPSTREAMS.openrouter}${sanitizedPath}`;
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
      azure: "AZURE_API_KEY",
      "azure-cognitive-services": "AZURE_COGNITIVE_SERVICES_API_KEY",
      "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
      "cloudflare-ai-gateway": "CLOUDFLARE_API_TOKEN",
      vercel: "AI_GATEWAY_API_KEY",
      zenmux: "ZENMUX_API_KEY",
      cerebras: "CEREBRAS_API_KEY",
      kilo: "KILO_API_KEY",
      "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
      gitlab: "GITLAB_TOKEN",
      "github-copilot": "GITHUB_TOKEN",
      "github-copilot-enterprise": "GITHUB_TOKEN",
      "sap-ai-core": "AICORE_SERVICE_KEY",
      opencode: "OPENCODE_API_KEY",
    };
    const envKey = envKeyMap[provider];
    if (envKey) {
      apiKey = process.env[envKey] ?? null;
    }
    if (!apiKey && (provider === "google-vertex" || provider === "google-vertex-anthropic")) {
      apiKey =
        process.env.GOOGLE_VERTEX_ACCESS_TOKEN?.trim() ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim() ||
        null;
    }
  }

  if (!apiKey) {
    // Last resort: use AI gateway — forward to its provider-compatible endpoint
    const gatewayKey = process.env.AI_GATEWAY_API_KEY;
    if (gatewayKey) {
      // Gateway passthrough not supported for raw proxy — the local agent
      // runtime should use createGateway() directly via gatewayApiKey instead.
      return new Response(
        JSON.stringify({ error: "Use gateway mode. Raw proxy requires a provider API key." }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ error: "No API key available for provider" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // 5. Forward to upstream
  const upstreamBase = resolveProviderUpstream(provider, apiKey);
  if (!upstreamBase) {
    return new Response(
      JSON.stringify({ error: `Provider ${provider} is not configured on server. Missing required environment configuration.` }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
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
  const authHeaders = await buildUpstreamAuthHeaders(ctx, provider, apiKey);
  // Remove any existing auth headers the client might have sent
  delete forwardHeaders["authorization"];
  delete forwardHeaders["Authorization"];
  delete forwardHeaders["x-api-key"];
  delete forwardHeaders["api-key"];
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
