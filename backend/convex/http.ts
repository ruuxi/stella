import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { generateText, createGateway } from "ai";
import { resolveModelConfig } from "./agent/model_resolver";
import {
  assertSensitiveSessionPolicyAction,
  authComponent,
  createAuth,
  requireConversationOwnerAction,
} from "./auth";
import {
  CORE_MEMORY_SYNTHESIS_PROMPT,
  buildCoreSynthesisUserMessage,
  buildWelcomeMessagePrompt,
  buildWelcomeSuggestionsPrompt,
  SKILL_METADATA_PROMPT,
  buildSkillMetadataUserMessage,
  SKILL_SELECTION_PROMPT,
  buildSkillSelectionUserMessage,
} from "./prompts/index";
import type { WelcomeSuggestion } from "./prompts/index";
import { registerConnectorWebhookRoutes } from "./http_routes/connectors";
import {
  preflightCorsResponse,
  rejectDisallowedCorsOrigin,
  withCors,
} from "./http_shared/cors";
import { rateLimitResponse } from "./http_shared/webhook_controls";


const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

const corsPreflightHandler = httpAction(async (_ctx, request) => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  return preflightCorsResponse(request);
});

// ---------------------------------------------------------------------------
// Core Memory Synthesis Endpoint
// ---------------------------------------------------------------------------

type SynthesizeRequest = {
  formattedSignals: string;
};

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  suggestions: WelcomeSuggestion[];
};
const DEFAULT_WELCOME_MESSAGE = "Hey! I'm Stella, your AI assistant. What can I help you with today?";
const MAX_ANON_SYNTHESIS_REQUESTS = 10;
const ANON_DEVICE_HASH_SALT_MISSING_MESSAGE = "Missing ANON_DEVICE_ID_HASH_SALT";
let didLogMissingAnonDeviceSaltForSynthesis = false;
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128;
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/;
const TRANSCRIBE_OWNER_RATE_LIMIT = 30;
const TRANSCRIBE_ANON_RATE_LIMIT = 10;
const TRANSCRIBE_RATE_WINDOW_MS = 60_000;

const MUSIC_KEY_RATE_LIMIT = 10;
const MUSIC_KEY_RATE_WINDOW_MS = 300_000;
const DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 120;
const MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 30;
const MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS = 600;
const WISPRFLOW_GENERATE_ACCESS_TOKEN_URL =
  process.env.WISPRFLOW_GENERATE_ACCESS_TOKEN_URL?.trim() ||
  process.env.WISPR_FLOW_GENERATE_ACCESS_TOKEN_URL?.trim() ||
  "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token";
const WISPRFLOW_CLIENT_WS_URL =
  process.env.WISPRFLOW_CLIENT_WS_URL?.trim() ||
  process.env.WISPR_FLOW_CLIENT_WS_URL?.trim() ||
  "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";

type SpeechToTextWsTokenRequest = {
  durationSecs?: number;
};

type SpeechToTextWsTokenResponse = {
  clientKey: string;
  expiresIn: number | null;
  websocketUrl: string;
};

const getAnonDeviceId = (request: Request): string | null => {
  const deviceId = request.headers.get("X-Device-ID");
  if (!deviceId) return null;
  const trimmed = deviceId.trim();
  if (trimmed.length === 0 || trimmed.length >= 256) return null;
  return trimmed;
};

const isAnonDeviceHashSaltMissingError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(ANON_DEVICE_HASH_SALT_MISSING_MESSAGE);

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

const clampTokenDurationSeconds = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }

  const rounded = Math.round(value);
  if (rounded < MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS) {
    return MIN_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }
  if (rounded > MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS) {
    return MAX_TRANSCRIBE_CLIENT_TOKEN_DURATION_SECS;
  }
  return rounded;
};

http.route({
  path: "/api/synthesize",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/synthesize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    const anonDeviceId = getAnonDeviceId(request);
    if (!identity && !anonDeviceId) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: SynthesizeRequest | null = null;
    try {
      body = (await request.json()) as SynthesizeRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.formattedSignals) {
      return withCors(
        new Response("formattedSignals is required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[synthesize] Missing AI_GATEWAY_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const gateway = createGateway({ apiKey });

    try {
      if (!identity && anonDeviceId) {
        try {
          const usage = await ctx.runMutation(internal.ai_proxy_data.consumeDeviceAllowance, {
            deviceId: anonDeviceId,
            maxRequests: MAX_ANON_SYNTHESIS_REQUESTS,
            clientAddressKey: getClientAddressKey(request) ?? undefined,
          });
          if (!usage.allowed) {
            return withCors(
              new Response(
                JSON.stringify({
                  error:
                    "Rate limit exceeded. Please create an account for continued access.",
                }),
                {
                  status: 429,
                  headers: { "Content-Type": "application/json" },
                },
              ),
              origin,
            );
          }
        } catch (error) {
          if (!isAnonDeviceHashSaltMissingError(error)) {
            throw error;
          }
          if (!didLogMissingAnonDeviceSaltForSynthesis) {
            didLogMissingAnonDeviceSaltForSynthesis = true;
            console.warn(
              "[synthesize] Missing ANON_DEVICE_ID_HASH_SALT; anonymous rate limiting is disabled until configured.",
            );
          }
        }
      }

      const ownerId = identity?.subject;
      const synthesisConfig = await resolveModelConfig(ctx, "synthesis", ownerId);
      const userMessage = buildCoreSynthesisUserMessage(body.formattedSignals);

      const synthesisModel = typeof synthesisConfig.model === "string"
        ? gateway(synthesisConfig.model)
        : synthesisConfig.model;
      const synthesisResult = await generateText({
        model: synthesisModel,
        system: CORE_MEMORY_SYNTHESIS_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: synthesisConfig.maxOutputTokens,
        temperature: synthesisConfig.temperature,
        providerOptions: synthesisConfig.providerOptions,
      });

      const coreMemory = synthesisResult.text?.trim();
      if (!coreMemory) {
        return withCors(
          new Response("Failed to synthesize core memory", { status: 500 }),
          origin,
        );
      }

      const welcomeConfig = await resolveModelConfig(ctx, "welcome", ownerId);
      const welcomePrompt = buildWelcomeMessagePrompt(coreMemory);

      const welcomeModel = typeof welcomeConfig.model === "string"
        ? gateway(welcomeConfig.model)
        : welcomeConfig.model;

      // Run welcome message and suggestions in parallel (both only need coreMemory)
      const suggestionsPrompt = buildWelcomeSuggestionsPrompt(coreMemory);

      const [welcomeResult, suggestionsResult] = await Promise.all([
        generateText({
          model: welcomeModel,
          messages: [{ role: "user", content: welcomePrompt }],
          maxOutputTokens: welcomeConfig.maxOutputTokens,
          temperature: welcomeConfig.temperature,
          providerOptions: welcomeConfig.providerOptions,
        }),
        generateText({
          model: welcomeModel,
          messages: [{ role: "user", content: suggestionsPrompt }],
          maxOutputTokens: 1024,
          temperature: 0.7,
        }).catch(() => null),
      ]);

      let suggestions: WelcomeSuggestion[] = [];
      try {
        const raw = suggestionsResult?.text?.trim() || "";
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          suggestions = parsed
            .filter(
              (s: unknown): s is WelcomeSuggestion =>
                typeof s === "object" &&
                s !== null &&
                typeof (s as WelcomeSuggestion).category === "string" &&
                typeof (s as WelcomeSuggestion).title === "string" &&
                typeof (s as WelcomeSuggestion).prompt === "string",
            )
            .slice(0, 5);
        }
      } catch {
        // Suggestions are non-critical — fallback to empty array
      }

      if (!welcomeResult.text?.trim()) {
        console.warn("[http] Welcome message LLM returned empty text, using default");
      }

      const response: SynthesizeResponse = {
        coreMemory,
        welcomeMessage: welcomeResult.text?.trim() || DEFAULT_WELCOME_MESSAGE,
        suggestions,
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[synthesize] Error:", error);
      return withCors(
        new Response(`Synthesis failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Speech-To-Text Endpoint
// ---------------------------------------------------------------------------

http.route({
  path: "/api/speech-to-text/ws-token",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/speech-to-text/ws-token",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    const anonDeviceId = getAnonDeviceId(request);
    if (!identity && !anonDeviceId) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: identity ? "speech_to_text_owner" : "speech_to_text_anon",
      key: identity?.subject ?? anonDeviceId!,
      limit: identity ? TRANSCRIBE_OWNER_RATE_LIMIT : TRANSCRIBE_ANON_RATE_LIMIT,
      windowMs: TRANSCRIBE_RATE_WINDOW_MS,
      blockMs: TRANSCRIBE_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    let body: SpeechToTextWsTokenRequest | null = null;
    try {
      body = (await request.json()) as SpeechToTextWsTokenRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (
      body &&
      typeof body !== "object"
    ) {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (
      body?.durationSecs !== undefined &&
      (typeof body.durationSecs !== "number" || !Number.isFinite(body.durationSecs))
    ) {
      return withCors(new Response("durationSecs must be a number", { status: 400 }), origin);
    }

    const apiKey = process.env.WISPRFLOW_API_KEY ?? process.env.WISPR_FLOW_API_KEY;
    if (!apiKey) {
      console.error("[speech-to-text/ws-token] Missing WISPRFLOW_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const durationSecs = clampTokenDurationSeconds(body?.durationSecs);
    const clientIdSource = identity?.subject ?? anonDeviceId!;
    const clientId = clientIdSource.slice(0, 240);

    try {
      const upstreamResponse = await fetch(WISPRFLOW_GENERATE_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          duration_secs: durationSecs,
          metadata: {
            source: "stella",
            feature: "voice",
          },
        }),
      });

      const upstreamText = await upstreamResponse.text();
      if (!upstreamResponse.ok) {
        return withCors(
          new Response(
            JSON.stringify({
              error: `Speech session token request failed: ${upstreamResponse.status}`,
              detail: upstreamText.slice(0, 2_000),
            }),
            {
              status: upstreamResponse.status,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      let upstreamJson: unknown;
      try {
        upstreamJson = upstreamText ? JSON.parse(upstreamText) : {};
      } catch {
        return withCors(
          new Response(
            JSON.stringify({ error: "Invalid upstream response" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      const result = upstreamJson as {
        access_token?: unknown;
        expires_in?: unknown;
      };

      if (typeof result.access_token !== "string" || result.access_token.trim().length === 0) {
        return withCors(
          new Response(
            JSON.stringify({ error: "Upstream response missing access token" }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          ),
          origin,
        );
      }

      const response: SpeechToTextWsTokenResponse = {
        clientKey: result.access_token,
        expiresIn: typeof result.expires_in === "number" ? result.expires_in : null,
        websocketUrl: WISPRFLOW_CLIENT_WS_URL,
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[speech-to-text/ws-token] Error:", error);
      return withCors(
        new Response(`Speech session token request failed: ${(error as Error).message}`, {
          status: 500,
        }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Memory Seeding Endpoint (discovery -> ephemeral memory)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/seed-memories",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/seed-memories",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    try {
      const body = (await request.json()) as { formattedSignals?: string };
      if (!body?.formattedSignals) {
        return withCors(
          new Response("Missing formattedSignals", { status: 400 }),
          origin,
        );
      }

      // Schedule seeding as async action (non-blocking)
      await ctx.scheduler.runAfter(0, internal.data.memory.seedFromDiscovery, {
        ownerId: identity.subject,
        formattedSignals: body.formattedSignals,
      });

      return withCors(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[seed-memories] Error:", error);
      return withCors(
        new Response(`Seed failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Skill Metadata Generation Endpoint
// ---------------------------------------------------------------------------

type SkillMetadataRequest = {
  markdown: string;
  skillDirName: string;
};

type SkillMetadataResponse = {
  metadata: {
    id: string;
    name: string;
    description: string;
    agentTypes: string[];
  };
};

http.route({
  path: "/api/generate-skill-metadata",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/generate-skill-metadata",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: SkillMetadataRequest | null = null;
    try {
      body = (await request.json()) as SkillMetadataRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.markdown || !body?.skillDirName) {
      return withCors(
        new Response("markdown and skillDirName are required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[generate-skill-metadata] Missing AI_GATEWAY_API_KEY environment variable");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    const gateway = createGateway({ apiKey });

    try {
      const userMessage = buildSkillMetadataUserMessage(body.skillDirName, body.markdown);

      const result = await generateText({
        model: gateway("openai/gpt-4o-mini"),
        system: SKILL_METADATA_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: 200,
        temperature: 0.3,
      });

      const text = result.text?.trim() || "";

      // Parse the YAML response
      const lines = text.split("\n");
      const metadata: Record<string, unknown> = {};

      for (const line of lines) {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;

        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();

        // Handle array values like [general-purpose]
        if (value.startsWith("[") && value.endsWith("]")) {
          const inner = value.slice(1, -1);
          metadata[key] = inner
            .split(",")
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter((s) => s.length > 0);
        } else {
          // Remove surrounding quotes
          value = value.replace(/^["']|["']$/g, "");
          metadata[key] = value;
        }
      }

      const response: SkillMetadataResponse = {
        metadata: {
          id: (metadata.id as string) || body.skillDirName,
          name: (metadata.name as string) || body.skillDirName,
          description: (metadata.description as string) || "Skill instructions.",
          agentTypes: (metadata.agentTypes as string[]) || ["general-purpose"],
        },
      };

      return withCors(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[generate-skill-metadata] Error:", error);
      return withCors(
        new Response(`Metadata generation failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Default Skill Selection Endpoint (onboarding)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/select-default-skills",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/select-default-skills",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    let body: { coreMemory?: string } | null = null;
    try {
      body = (await request.json()) as { coreMemory?: string };
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.coreMemory) {
      return withCors(
        new Response("coreMemory is required", { status: 400 }),
        origin,
      );
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      console.error("[select-default-skills] Missing AI_GATEWAY_API_KEY");
      return withCors(
        new Response("Server configuration error", { status: 500 }),
        origin,
      );
    }

    try {
      // 1. Fetch all skills for this user
      const catalog = await ctx.runQuery(
        internal.data.skills.listAllSkillsForSelection,
        { ownerId: identity.subject },
      );

      if (catalog.length === 0) {
        return withCors(
          new Response(JSON.stringify({ selectedSkillIds: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
          origin,
        );
      }

      // 2. Call LLM to select relevant skills
      const gateway = createGateway({ apiKey });
      const userMessage = buildSkillSelectionUserMessage(body.coreMemory, catalog);

      const result = await generateText({
        model: gateway("openai/gpt-4o-mini"),
        system: SKILL_SELECTION_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        maxOutputTokens: 300,
        temperature: 0.3,
      });

      const text = (result.text ?? "").trim();

      // 3. Parse JSON array of skill IDs
      let selectedSkillIds: string[] = [];
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          selectedSkillIds = parsed.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          );
        }
      } catch {
        console.error("[select-default-skills] Failed to parse LLM response:", text);
      }

      // 4. Enable selected skills
      if (selectedSkillIds.length > 0) {
        await ctx.runMutation(internal.data.skills.enableSelectedSkills, {
          ownerId: identity.subject,
          skillIds: selectedSkillIds,
        });
      }

      return withCors(
        new Response(JSON.stringify({ selectedSkillIds }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        origin,
      );
    } catch (error) {
      console.error("[select-default-skills] Error:", error);
      return withCors(
        new Response(`Skill selection failed: ${(error as Error).message}`, { status: 500 }),
        origin,
      );
    }
  }),
});

registerConnectorWebhookRoutes(http);

// ---------------------------------------------------------------------------
// Stella AI Proxy — thin LLM/embed/search proxy for desktop local runtime
// ---------------------------------------------------------------------------

import { proxyChat, proxyEmbed, proxySearch, llmProxy } from "./ai_proxy";

const proxyOptionsHandler = httpAction(async (_ctx, request) => {
  const rejection = rejectDisallowedCorsOrigin(request);
  if (rejection) return rejection;
  return preflightCorsResponse(request);
});

http.route({ path: "/api/ai/proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/proxy", method: "POST", handler: proxyChat });

http.route({ path: "/api/ai/embed", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/embed", method: "POST", handler: proxyEmbed });

http.route({ path: "/api/ai/search", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/search", method: "POST", handler: proxySearch });

// Transparent LLM reverse proxy for local agent runtime
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ pathPrefix: "/api/ai/llm-proxy/", method: "POST", handler: llmProxy });

// ---------------------------------------------------------------------------
// Music Generation — API Key Endpoint
// ---------------------------------------------------------------------------

http.route({
  path: "/api/music/api-key",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/music/api-key",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    // Require authenticated user (no anonymous access for API key distribution)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "music_api_key",
      key: identity.subject,
      limit: MUSIC_KEY_RATE_LIMIT,
      windowMs: MUSIC_KEY_RATE_WINDOW_MS,
      blockMs: MUSIC_KEY_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    // Resolve Google AI API key via BYOK chain, then platform env var
    const ownerId = identity.subject;
    let apiKey: string | null = null;

    try {
      apiKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: "llm:google",
      });
    } catch {
      // No BYOK key stored, fall through to env var
    }

    if (!apiKey) {
      apiKey = process.env.GOOGLE_AI_API_KEY ?? null;
    }

    if (!apiKey) {
      return withCors(
        new Response(
          JSON.stringify({ error: "No Google AI API key configured. Add one in Settings or contact your administrator." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }

    return withCors(
      new Response(JSON.stringify({ apiKey }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      origin,
    );
  }),
});

// --- Voice-to-Voice (Realtime API) ---

const VOICE_SESSION_RATE_LIMIT = 10; // per minute
const VOICE_SESSION_RATE_WINDOW_MS = 60_000;
const CONVEX_CONVERSATION_ID_PATTERN = /^[a-z][a-z0-9]+$/;

const asConvexConversationId = (value: unknown): Id<"conversations"> | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!CONVEX_CONVERSATION_ID_PATTERN.test(normalized)) return null;
  return normalized as Id<"conversations">;
};

http.route({
  path: "/api/voice/session",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/voice/session",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "voice_session",
      key: identity.subject,
      limit: VOICE_SESSION_RATE_LIMIT,
      windowMs: VOICE_SESSION_RATE_WINDOW_MS,
      blockMs: VOICE_SESSION_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
    }

    type VoiceSessionBody = { conversationId?: string; voice?: string; model?: string };
    let body: VoiceSessionBody | null = null;
    try {
      body = (await request.json()) as VoiceSessionBody;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    // Resolve owner ID from identity
    const ownerId = identity.subject;

    // Conversation ID is optional — local-mode conversations use locally-generated
    // ULIDs (uppercase, digit-prefixed) that aren't valid Convex document IDs.
    // Only attempt ownership verification for IDs that look like Convex IDs
    // (lowercase, no leading digits) to avoid noisy validation errors in logs.
    let convexConversationId: Id<"conversations"> | undefined;
    const parsedConvId = asConvexConversationId(body?.conversationId);
    if (parsedConvId) {
      try {
        await requireConversationOwnerAction(ctx, parsedConvId);
        convexConversationId = parsedConvId;
      } catch {
        // Conversation not found - skip context enrichment
      }
    }

    // Resolve OpenAI API key: BYOK first, then platform key
    let openaiApiKey: string | null = null;
    try {
      openaiApiKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: "llm:openai",
      });
    } catch {
      // BYOK lookup failed — fall through to platform key
    }
    if (!openaiApiKey) {
      openaiApiKey = process.env.OPENAI_API_KEY ?? null;
    }
    if (!openaiApiKey) {
      return withCors(
        new Response(
          JSON.stringify({ error: "No OpenAI API key configured. Add one in Settings or set OPENAI_API_KEY." }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }

    // Build voice session instructions with dynamic context
    const { buildVoiceSessionInstructions } = await import("./prompts/voice_orchestrator");
    const { getVoiceToolSchemas } = await import("./tools/voice_schemas");

    // Fetch dynamic context for the instructions
    let deviceStatus: string | undefined;
    let activeThreads: string | undefined;
    let coreMemory: string | undefined;
    let userName: string | undefined;

    try {
      const deviceResult = await ctx.runQuery(
        internal.agent.device_resolver.getDeviceStatus,
        { ownerId },
      );
      const lines = ["# Device Status"];
      lines.push(`- Local device: ${deviceResult.localOnline ? "online" : "offline"}`);
      deviceStatus = lines.join("\n");
    } catch {
      // Skip device status
    }

    try {
      if (!convexConversationId) throw new Error("skip");
      const threads = await ctx.runQuery(internal.data.threads.listActiveThreads, {
        ownerId,
        conversationId: convexConversationId,
      });
      const subagentThreads = (threads as Array<{ _id: string; name: string; messageCount: number }>)
        .filter((t) => t.name !== "Main");
      if (subagentThreads.length > 0) {
        const lines = ["# Active Threads"];
        for (const t of subagentThreads.slice(0, 10)) {
          lines.push(`- ${t.name} (id: ${t._id}, ${t.messageCount} messages)`);
        }
        activeThreads = lines.join("\n");
      }
    } catch {
      // Skip threads
    }

    // Get user profile name if available
    try {
      userName = identity.name ?? identity.nickname ?? undefined;
    } catch {
      // Skip
    }

    const instructions = buildVoiceSessionInstructions({
      userName,
      platform: "desktop",
      deviceStatus,
      activeThreads,
      coreMemory,
    });

    const tools = getVoiceToolSchemas();
    const model = body.model ?? "gpt-realtime-1.5";
    const voice = body.voice ?? "marin";

    // Request ephemeral client secret from OpenAI
    const sessionConfig = {
      model,
      voice,
      instructions,
      tools,
      input_audio_transcription: {
        model: "gpt-4o-transcribe",
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
    };

    try {
      const openaiResponse = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sessionConfig),
      });

      const responseText = await openaiResponse.text();
      if (!openaiResponse.ok) {
        console.error("[voice/session] OpenAI sessions failed:", openaiResponse.status, responseText);
        return withCors(
          new Response(
            JSON.stringify({ error: "Failed to create voice session", detail: responseText }),
            { status: openaiResponse.status, headers: { "Content-Type": "application/json" } },
          ),
          origin,
        );
      }

      const openaiData = JSON.parse(responseText);
      return withCors(
        new Response(
          JSON.stringify({
            clientSecret: openaiData.client_secret?.value ?? openaiData.client_secret,
            expiresAt: openaiData.client_secret?.expires_at,
            model,
            voice,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    } catch (error) {
      console.error("[voice/session] Failed to contact OpenAI:", (error as Error).message);
      return withCors(
        new Response(
          JSON.stringify({ error: "Failed to create voice session" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
        origin,
      );
    }
  }),
});

// Voice transcript logging endpoint
http.route({
  path: "/api/voice/log",
  method: "OPTIONS",
  handler: corsPreflightHandler,
});

http.route({
  path: "/api/voice/log",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    // Voice transcript/event logging is intentionally disabled.
    // Keep this endpoint as a no-op for older clients.
    return withCors(
      new Response(JSON.stringify({ ok: true, skipped: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      origin,
    );
  }),
});

export default http;

