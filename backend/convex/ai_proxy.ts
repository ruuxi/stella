/**
 * Stella AI Proxy — thin proxy for LLM and embedding requests.
 * Used by the desktop local runtime when BYOK keys are not available.
 *
 * Auth:
 * - Bearer JWT: logged-in user, full access
 * - X-Device-ID: pre-login onboarding, rate-limited (10 requests)
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
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128;
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/;

type ProxyAuth =
  | { type: "jwt"; userId: string }
  | { type: "device"; deviceId: string }
  | { type: "none" };

async function resolveAuth(ctx: ActionCtx, request: Request): Promise<ProxyAuth> {
  // Try JWT first
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return { type: "jwt", userId: identity.subject };
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

async function consumeDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  const usage = await ctx.runMutation(internal.ai_proxy_data.consumeDeviceAllowance, {
    deviceId,
    maxRequests: MAX_ANON_REQUESTS,
    clientAddressKey: clientAddressKey ?? undefined,
  });
  return usage.allowed;
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
  }

  // Web search requires server-side API key (Brave, Tavily, etc.)
  const searchApiKey = process.env.SEARCH_API_KEY;
  const searchProvider = process.env.SEARCH_PROVIDER || "tavily";

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
