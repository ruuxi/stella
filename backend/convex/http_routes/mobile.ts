import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  assertSensitiveSessionPolicyAction,
  createAuth,
  isAnonymousIdentity,
} from "../auth";
import { AGENT_IDS } from "../lib/agent_constants";
import { MANAGED_GATEWAY } from "../agent/model";
import { resolveFallbackConfig, resolveModelConfig } from "../agent/model_resolver";
import { OFFLINE_RESPONDER_SYSTEM_PROMPT } from "../prompts/offline_responder";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
  corsPreflightHandler,
} from "../http_shared/cors";
import { rateLimitResponse } from "../http_shared/webhook_controls";
import {
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "../lib/managed_billing";
import {
  assistantText,
  completeManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";

const OFFLINE_CHAT_RATE_LIMIT = 12;
const OFFLINE_CHAT_RATE_WINDOW_MS = 60_000;
const MAX_BASE_URLS = 8;
const MAX_DEVICE_ID_LENGTH = 256;

const MAGIC_LINK_RATE_LIMIT = 3;
const MAGIC_LINK_RATE_WINDOW_MS = 60_000;
const MAGIC_LINK_EXPIRY_MS = 10 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AuthenticatedOwnerResult =
  | { ownerId: string; name?: string; isAnonymous: boolean }
  | { response: Response };

const readConvexErrorCode = (error: unknown) => {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data = error.data;
  if (
    data
    && typeof data === "object"
    && typeof (data as { code?: unknown }).code === "string"
  ) {
    return (data as { code: string }).code;
  }
  return null;
};

const readConvexErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (
      data
      && typeof data === "object"
      && typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const requireMobileAccountOwner = async (
  ctx: ActionCtx,
  origin: string | null,
): Promise<AuthenticatedOwnerResult> => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return { response: errorResponse(401, "Unauthorized", origin) };
  }
  if (isAnonymousIdentity(identity)) {
    return {
      response: errorResponse(
        403,
        "Sign in with an account to use Stella mobile.",
        origin,
      ),
    };
  }

  try {
    await assertSensitiveSessionPolicyAction(ctx, identity);
  } catch (error) {
    return {
      response: errorResponse(
        401,
        readConvexErrorMessage(error, "Unauthorized"),
        origin,
      ),
    };
  }

  return {
    ownerId: identity.subject,
    name:
      typeof identity.name === "string" && identity.name.trim().length > 0
        ? identity.name.trim()
        : undefined,
    isAnonymous: false,
  };
};

const normalizeDeviceId = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, MAX_DEVICE_ID_LENGTH);
};

const normalizePlatform = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : undefined;
};

const normalizeBaseUrls = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        continue;
      }
      unique.add(url.toString().replace(/\/+$/, ""));
    } catch {
      continue;
    }
    if (unique.size >= MAX_BASE_URLS) {
      break;
    }
  }

  return Array.from(unique);
};

const generateOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
}) => {
  const modelAccess = await resolveManagedModelAccess(args.ctx, args.ownerId, {
    isAnonymous: args.isAnonymous,
  });
  if (!modelAccess.allowed) {
    throw new ConvexError({
      code: "USAGE_LIMIT_REACHED",
      message: modelAccess.message,
    });
  }

  const primaryConfig = await resolveModelConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess },
  );
  const fallbackConfig = await resolveFallbackConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess },
  );

  const systemPrompt = [
    OFFLINE_RESPONDER_SYSTEM_PROMPT,
    "You are replying inside Stella's mobile offline chat.",
    "Answer in plain text and keep the response practical and concise.",
    args.userName ? `The user's name is ${args.userName}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const execute = async (config: typeof primaryConfig) =>
    await completeManagedChat({
      config,
      context: {
        systemPrompt,
        messages: [{
          role: "user",
          content: [{ type: "text", text: args.message }],
          timestamp: Date.now(),
        }],
      },
    });

  const startedAt = Date.now();
  let activeModel = primaryConfig.model;
  let result;
  try {
    result = await execute(primaryConfig);
  } catch (error) {
    if (!fallbackConfig) {
      throw error;
    }
    activeModel = fallbackConfig.model;
    result = await execute(fallbackConfig);
  }

  await scheduleManagedUsage(args.ctx, {
    ownerId: args.ownerId,
    agentType: "service:offline_chat",
    model: activeModel,
    durationMs: Date.now() - startedAt,
    success: true,
    usage: usageSummaryFromAssistant(result),
  });

  const text = assistantText(result);
  return text || "I'm here, but I couldn't generate a reply right now.";
};

export const registerMobileRoutes = (http: HttpRouter) => {
  for (const path of [
    "/api/mobile/offline-chat",
    "/api/mobile/desktop-bridge/register",
    "/api/mobile/desktop-bridge/clear",
    "/api/mobile/desktop-bridge/authorize",
    "/api/mobile/desktop-bridge/tunnel-token",
  ]) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) =>
        corsPreflightHandler(request),
      ),
    });
  }

  http.route({
    path: "/api/mobile/offline-chat",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(
            `[mobile/offline-chat] Missing ${MANAGED_GATEWAY.apiKeyEnvVar}`,
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "mobile_offline_chat",
            key: owner.ownerId,
            limit: OFFLINE_CHAT_RATE_LIMIT,
            windowMs: OFFLINE_CHAT_RATE_WINDOW_MS,
            blockMs: OFFLINE_CHAT_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        let body: { message?: unknown } | null = null;
        try {
          body = (await request.json()) as { message?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const message =
          typeof body?.message === "string" ? body.message.trim() : "";
        if (!message) {
          return errorResponse(400, "message is required", origin);
        }

        try {
          const text = await generateOfflineReply({
            ctx,
            ownerId: owner.ownerId,
            userName: owner.name,
            message,
            isAnonymous: owner.isAnonymous,
          });
          return jsonResponse({ text }, 200, origin);
        } catch (error) {
          console.error("[mobile/offline-chat] Error:", error);
          const status =
            readConvexErrorCode(error) === "USAGE_LIMIT_REACHED" ? 429 : 500;
          return errorResponse(
            status,
            readConvexErrorMessage(error, "Offline chat failed"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const registration = await ctx.runQuery(
          internal.mobile_bridge.getLatestRegistrationForOwner,
          { ownerId: owner.ownerId },
        );
        if (!registration) {
          return jsonResponse(
            {
              available: false,
              baseUrls: [],
              platform: null,
              updatedAt: null,
            },
            200,
            origin,
          );
        }

        return jsonResponse(
          {
            available: registration.available,
            baseUrls: registration.available ? registration.baseUrls : [],
            platform: registration.platform ?? null,
            updatedAt: registration.updatedAt,
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/register",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        let body:
          | {
              deviceId?: unknown;
              baseUrls?: unknown;
              platform?: unknown;
            }
          | null = null;
        try {
          body = (await request.json()) as {
            deviceId?: unknown;
            baseUrls?: unknown;
            platform?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        const baseUrls = normalizeBaseUrls(body?.baseUrls);
        const platform = normalizePlatform(body?.platform);
        if (!deviceId || baseUrls.length === 0) {
          return errorResponse(400, "deviceId and baseUrls are required", origin);
        }

        await ctx.runMutation(internal.mobile_bridge.upsertRegistration, {
          ownerId: owner.ownerId,
          deviceId,
          baseUrls,
          updatedAt: Date.now(),
          ...(platform ? { platform } : {}),
        });

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/clear",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        await ctx.runMutation(internal.mobile_bridge.clearRegistration, {
          ownerId: owner.ownerId,
          deviceId,
        });
        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/authorize",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const deviceId = normalizeDeviceId(body?.deviceId);
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        const registration = await ctx.runQuery(
          internal.mobile_bridge.getRegistrationForOwnerDevice,
          {
            ownerId: owner.ownerId,
            deviceId,
          },
        );
        if (!registration?.available) {
          return errorResponse(403, "Desktop bridge is unavailable", origin);
        }

        return jsonResponse({ ok: true }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/mobile/desktop-bridge/tunnel-token",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        try {
          const result = await ctx.runAction(
            internal.cloudflare_tunnels.getOrProvisionTunnel,
            { ownerId: owner.ownerId },
          );
          return jsonResponse(result, 200, origin);
        } catch (error) {
          console.error("[mobile/tunnel-token] Error:", error);
          return errorResponse(
            500,
            readConvexErrorMessage(error, "Failed to provision tunnel"),
            origin,
          );
        }
      }),
    ),
  });

  // ── Mobile magic link (no-redirect) ────────────────────────────────

  for (const path of [
    "/api/auth/link/send",
    "/api/auth/link/status",
  ]) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(async (_ctx, request) =>
        corsPreflightHandler(request),
      ),
    });
  }

  // Send a magic link and return a requestId for polling.
  http.route({
    path: "/api/auth/link/send",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        let body: { email?: unknown } | null = null;
        try {
          body = (await request.json()) as { email?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const email =
          typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || !EMAIL_PATTERN.test(email)) {
          return errorResponse(400, "A valid email is required.", origin);
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "mobile_magic_link",
            key: email,
            limit: MAGIC_LINK_RATE_LIMIT,
            windowMs: MAGIC_LINK_RATE_WINDOW_MS,
            blockMs: MAGIC_LINK_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const convexSiteUrl = process.env.CONVEX_SITE_URL;
        if (!convexSiteUrl) {
          console.error("[mobile/auth] Missing CONVEX_SITE_URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();

        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email,
          requestId,
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
        });

        const callbackURL = `${convexSiteUrl}/api/auth/link/verify?requestId=${encodeURIComponent(requestId)}`;

        try {
          const auth = createAuth(ctx);
          await auth.api.signInMagicLink({
            body: { email, callbackURL },
            headers: new Headers({ origin: convexSiteUrl }),
          });
        } catch (error) {
          console.error("[mobile/auth] Failed to send magic link:", error);
          return errorResponse(500, "Failed to send sign-in email.", origin);
        }

        // Clean up after expiry.
        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        return jsonResponse({ requestId }, 200, origin);
      }),
    ),
  });

  // Poll for magic link verification status.
  http.route({
    path: "/api/auth/link/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const url = new URL(request.url);
        const requestId = url.searchParams.get("requestId") ?? "";
        if (!requestId) {
          return errorResponse(400, "requestId is required", origin);
        }

        const result = await ctx.runQuery(
          internal.mobile_auth.getLinkRequestStatus,
          { requestId },
        );
        if (!result) {
          return errorResponse(404, "Request not found", origin);
        }

        return jsonResponse(result, 200, origin);
      }),
    ),
  });

  // Browser landing after magic link verification.
  // The cross-domain plugin appends ?ott=... to this URL after verifying the token.
  // Exchanges the OTT for a session token server-side, stores it, then redirects.
  http.route({
    path: "/api/auth/link/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        // Exchange OTT for session token server-side (bypasses client CSRF issues)
        const convexSiteUrl = process.env.CONVEX_SITE_URL ?? "";
        try {
          const verifyRes = await fetch(
            `${convexSiteUrl}/api/auth/one-time-token/verify`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                origin: convexSiteUrl,
              },
              body: JSON.stringify({ token: ott }),
            },
          );
          const sessionCookie = verifyRes.headers.get("set-cookie") ?? "";
          await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
            requestId,
            ott,
            sessionCookie,
          });
        } catch {
          await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
            requestId,
            ott,
          });
        }
      }

      const websiteUrl = process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });
};
