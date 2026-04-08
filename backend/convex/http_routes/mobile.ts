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
import {
  resolveFallbackConfig,
  resolveModelConfig,
} from "../agent/model_resolver";
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
  streamManagedChat,
  usageSummaryFromAssistant,
} from "../runtime_ai/managed";
import { processIncomingMessage } from "../channels/message_pipeline";
import { MOBILE_BRIDGE_LEASE_MS } from "../mobile_bridge";
import { verifyPairedMobileSecret } from "../mobile_access";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Usage,
  UserMessage,
} from "../runtime_ai/types";

const OFFLINE_CHAT_RATE_LIMIT = 12;
const OFFLINE_CHAT_RATE_WINDOW_MS = 60_000;
const MAX_BASE_URLS = 8;
const MAX_DEVICE_ID_LENGTH = 256;
const MAX_OFFLINE_HISTORY_ITEMS = 40;
const MAX_OFFLINE_MESSAGE_CHARS = 12_000;
const MAX_OFFLINE_IMAGES = 5;
/** ~6M chars base64 ≈ ~4.5MB decoded — guardrail per image */
const MAX_IMAGE_BASE64_CHARS = 6_000_000;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantHistoryMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "managed",
  model: "offline-history",
  usage: EMPTY_USAGE,
  stopReason: "stop",
  timestamp: Date.now(),
});

const parseOfflineHistory = (
  raw: unknown,
): Array<{ role: "user" | "assistant"; text: string }> => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { role?: unknown; text?: unknown };
    const role = record.role;
    const text =
      typeof record.text === "string"
        ? record.text.slice(0, MAX_OFFLINE_MESSAGE_CHARS)
        : "";
    const trimmed = text.trim();
    if (!trimmed || (role !== "user" && role !== "assistant")) {
      continue;
    }
    out.push({ role, text: trimmed });
  }
  return out.slice(-MAX_OFFLINE_HISTORY_ITEMS);
};

const parseOfflineImages = (
  raw: unknown,
): Array<{ base64: string; mimeType: string }> => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Array<{ base64: string; mimeType: string }> = [];
  for (const item of raw) {
    if (out.length >= MAX_OFFLINE_IMAGES) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { base64?: unknown; mimeType?: unknown };
    const base64 = typeof record.base64 === "string" ? record.base64 : "";
    if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS) {
      continue;
    }
    const mimeType =
      typeof record.mimeType === "string" && record.mimeType.trim().length > 0
        ? record.mimeType.trim()
        : "image/jpeg";
    out.push({ base64, mimeType });
  }
  return out;
};

const buildOfflineChatContext = (args: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  message: string;
  images: Array<{ base64: string; mimeType: string }>;
}): Context => {
  const messages: Message[] = [];
  for (const turn of args.history) {
    if (turn.role === "user") {
      messages.push({
        role: "user",
        content: turn.text,
        timestamp: Date.now(),
      });
    } else {
      messages.push(assistantHistoryMessage(turn.text));
    }
  }

  const parts: Array<TextContent | ImageContent> = [];
  const msg = args.message.trim();
  if (msg) {
    parts.push({ type: "text", text: msg });
  }
  for (const img of args.images) {
    parts.push({
      type: "image",
      data: img.base64,
      mimeType: img.mimeType,
    });
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: "(Image)" });
  }

  let userContent: UserMessage["content"];
  if (parts.length === 1 && parts[0].type === "text") {
    userContent = parts[0].text;
  } else {
    userContent = parts;
  }

  messages.push({
    role: "user",
    content: userContent,
    timestamp: Date.now(),
  });

  return {
    systemPrompt: args.systemPrompt,
    messages,
  };
};

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
    data &&
    typeof data === "object" &&
    typeof (data as { code?: unknown }).code === "string"
  ) {
    return (data as { code: string }).code;
  }
  return null;
};

const readConvexErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
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

const requirePairedMobileCredentials = async (
  ctx: ActionCtx,
  request: Request,
  args: { ownerId: string; desktopDeviceId: string; origin: string | null },
): Promise<
  | { mobileDeviceId: string }
  | { response: Response }
> => {
  const mobileDeviceId = normalizeDeviceId(
    request.headers.get("X-Stella-Mobile-Device-Id"),
  );
  const pairSecret =
    request.headers.get("X-Stella-Mobile-Pair-Secret")?.trim() ?? "";
  if (!mobileDeviceId || !pairSecret) {
    return {
      response: errorResponse(
        403,
        "A paired phone credential is required",
        args.origin,
      ),
    };
  }

  const pairedDevice = await ctx.runQuery(
    internal.mobile_access.getPairedMobileDevice,
    {
      ownerId: args.ownerId,
      desktopDeviceId: args.desktopDeviceId,
      mobileDeviceId,
    },
  );
  if (!pairedDevice) {
    return {
      response: errorResponse(403, "This phone is not paired", args.origin),
    };
  }

  const secretOk = await verifyPairedMobileSecret({
    pairSecret,
    pairSecretHash: pairedDevice.pairSecretHash,
  });
  if (!secretOk) {
    return {
      response: errorResponse(
        403,
        "This phone credential is invalid",
        args.origin,
      ),
    };
  }

  return { mobileDeviceId };
};

const generateOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: Array<{ base64: string; mimeType: string }>;
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
    "Use prior messages in this conversation for context when relevant.",
    args.userName ? `The user's name is ${args.userName}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const context = buildOfflineChatContext({
    systemPrompt,
    history: args.history,
    message: args.message,
    images: args.images,
  });

  const execute = async (config: typeof primaryConfig) =>
    await completeManagedChat({
      config,
      context,
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

const streamOfflineReply = async (args: {
  ctx: ActionCtx;
  ownerId: string;
  userName?: string;
  message: string;
  isAnonymous: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  images: Array<{ base64: string; mimeType: string }>;
  origin: string | null;
}): Promise<Response> => {
  const modelAccess = await resolveManagedModelAccess(args.ctx, args.ownerId, {
    isAnonymous: args.isAnonymous,
  });

  if (!modelAccess.allowed) {
    return errorResponse(429, modelAccess.message, args.origin);
  }

  const config = await resolveModelConfig(
    args.ctx,
    AGENT_IDS.OFFLINE_RESPONDER,
    args.ownerId,
    { access: modelAccess },
  );

  const systemPrompt = [
    OFFLINE_RESPONDER_SYSTEM_PROMPT,
    "You are replying inside Stella's mobile offline chat.",
    "Answer in plain text and keep the response practical and concise.",
    "Use prior messages in this conversation for context when relevant.",
    args.userName ? `The user's name is ${args.userName}.` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const context = buildOfflineChatContext({
    systemPrompt,
    history: args.history,
    message: args.message,
    images: args.images,
  });

  const startedAt = Date.now();
  const eventStream = streamManagedChat({ config, context });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        let finalMessage: AssistantMessage | null = null;
        for await (const event of eventStream) {
          if (event.type === "text_delta") {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ t: event.delta })}\n\n`),
            );
          } else if (event.type === "done") {
            finalMessage = event.message;
          } else if (event.type === "error") {
            finalMessage = event.error;
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

        void scheduleManagedUsage(args.ctx, {
          ownerId: args.ownerId,
          agentType: "service:offline_chat",
          model: config.model,
          durationMs: Date.now() - startedAt,
          success: true,
          usage: usageSummaryFromAssistant(finalMessage),
        });
      } catch (error) {
        console.error("[mobile/offline-chat-stream] Error:", error);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: "Stream failed" })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (args.origin) {
    headers["Access-Control-Allow-Origin"] = args.origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return new Response(readable, { status: 200, headers });
};

export const registerMobileRoutes = (http: HttpRouter) => {
  for (const path of [
    "/api/mobile/offline-chat",
    "/api/mobile/offline-chat/stream",
    "/api/mobile/chat",
    "/api/mobile/pairing/complete",
    "/api/mobile/desktop-bridge/register",
    "/api/mobile/desktop-bridge/clear",
    "/api/mobile/desktop-bridge/request",
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

        let body: {
          message?: unknown;
          history?: unknown;
          images?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            message?: unknown;
            history?: unknown;
            images?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid request body", origin);
        }

        const message =
          typeof body?.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body?.history);
        const images = parseOfflineImages(body?.images);

        if (!message && images.length === 0) {
          return errorResponse(400, "Message or image required", origin);
        }

        try {
          const text = await generateOfflineReply({
            ctx,
            ownerId: owner.ownerId,
            userName: owner.name,
            message,
            isAnonymous: owner.isAnonymous,
            history,
            images,
          });
          return jsonResponse({ text }, 200, origin);
        } catch (error) {
          console.error("[mobile/offline-chat] Error:", error);
          const status =
            readConvexErrorCode(error) === "USAGE_LIMIT_REACHED" ? 429 : 500;
          return errorResponse(
            status,
            readConvexErrorMessage(error, "Could not send your message"),
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/mobile/offline-chat/stream",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
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

        let body: {
          message?: unknown;
          history?: unknown;
          images?: unknown;
        };
        try {
          body = (await request.json()) as {
            message?: unknown;
            history?: unknown;
            images?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid request body", origin);
        }

        const message =
          typeof body.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const history = parseOfflineHistory(body.history);
        const images = parseOfflineImages(body.images);

        if (!message && images.length === 0) {
          return errorResponse(400, "Message or image required", origin);
        }

        return streamOfflineReply({
          ctx,
          ownerId: owner.ownerId,
          userName: owner.name,
          message,
          isAnonymous: owner.isAnonymous,
          history,
          images,
          origin,
        });
      }),
    ),
  });

  http.route({
    path: "/api/mobile/chat",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
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

        let body: { message?: unknown; mobileDeviceId?: unknown };
        try {
          body = (await request.json()) as { message?: unknown; mobileDeviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid request body", origin);
        }

        const message =
          typeof body.message === "string"
            ? body.message.slice(0, MAX_OFFLINE_MESSAGE_CHARS).trim()
            : "";
        const mobileDeviceId = normalizeDeviceId(body.mobileDeviceId);

        if (!message) {
          return errorResponse(400, "Message required", origin);
        }
        if (!mobileDeviceId) {
          return errorResponse(400, "mobileDeviceId required", origin);
        }

        const beforeSend = Date.now();

        const conversationId = await ctx.runMutation(
          internal.channels.utils.getOrCreateConversationForOwner,
          { ownerId: owner.ownerId },
        );

        const result = await processIncomingMessage({
          ctx,
          ownerId: owner.ownerId,
          provider: "stella_app",
          externalUserId: mobileDeviceId,
          text: message,
          preEnsureOwnerConnection: true,
          deliveryMeta: { mobileOwnerId: owner.ownerId },
        });

        if (!result) {
          return errorResponse(500, "Could not process message", origin);
        }

        if (!result.deferred && result.text) {
          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ t: result.text })}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          const headers: Record<string, string> = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          };
          if (origin) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers["Access-Control-Allow-Credentials"] = "true";
          }
          return new Response(readable, { status: 200, headers });
        }

        const POLL_INTERVAL_MS = 500;
        const MAX_POLL_MS = 30_000;
        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(controller) {
            const deadline = beforeSend + MAX_POLL_MS;
            let found = false;

            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

              const events = (await ctx.runQuery(
                internal.events.listEventsSince,
                {
                  conversationId,
                  afterTimestamp: beforeSend - 1000,
                  limit: 20,
                },
              )) as Array<{ type: string; payload: Record<string, unknown> }> | null;

              if (events) {
                for (let i = events.length - 1; i >= 0; i--) {
                  if (events[i].type === "assistant_message") {
                    const text = (events[i].payload?.text as string) ?? "";
                    if (text) {
                      controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ t: text })}\n\n`),
                      );
                      found = true;
                      break;
                    }
                  }
                }
              }
              if (found) break;
            }

            if (!found) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ t: "Sorry, I couldn\u2019t reach your computer in time. Try again or send without desktop." })}\n\n`,
                ),
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        const headers: Record<string, string> = {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        };
        if (origin) {
          headers["Access-Control-Allow-Origin"] = origin;
          headers["Access-Control-Allow-Credentials"] = "true";
        }
        return new Response(readable, { status: 200, headers });
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

        const url = new URL(request.url);
        const requestedDesktopDeviceId = normalizeDeviceId(
          url.searchParams.get("desktopDeviceId"),
        );
        const nowMs = Date.now();
        const registration = requestedDesktopDeviceId
          ? await ctx.runQuery(
              internal.mobile_bridge.getRegistrationForOwnerDevice,
              {
                ownerId: owner.ownerId,
                deviceId: requestedDesktopDeviceId,
                nowMs,
              },
            )
          : await ctx.runQuery(
              internal.mobile_bridge.getLatestRegistrationForOwner,
              { ownerId: owner.ownerId, nowMs },
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
    path: "/api/mobile/pairing/complete",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        let body: {
          pairingCode?: unknown;
          mobileDeviceId?: unknown;
          displayName?: unknown;
          platform?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            pairingCode?: unknown;
            mobileDeviceId?: unknown;
            displayName?: unknown;
            platform?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const pairingCode =
          typeof body?.pairingCode === "string"
            ? body.pairingCode.trim().toUpperCase().slice(0, 12)
            : "";
        const mobileDeviceId = normalizeDeviceId(body?.mobileDeviceId);
        const displayName =
          typeof body?.displayName === "string"
            ? body.displayName.trim().slice(0, 64)
            : undefined;
        const platform = normalizePlatform(body?.platform);

        if (!pairingCode || !mobileDeviceId) {
          return errorResponse(
            400,
            "pairingCode and mobileDeviceId are required",
            origin,
          );
        }

        try {
          const result = await ctx.runMutation(
            internal.mobile_access.completePairingSession,
            {
              ownerId: owner.ownerId,
              pairingCode,
              mobileDeviceId,
              ...(displayName ? { displayName } : {}),
              ...(platform ? { platform } : {}),
            },
          );
          return jsonResponse(result, 200, origin);
        } catch (error) {
          return errorResponse(
            400,
            readConvexErrorMessage(error, "Unable to pair this phone"),
            origin,
          );
        }
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

        let body: {
          deviceId?: unknown;
          baseUrls?: unknown;
          platform?: unknown;
        } | null = null;
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
          return errorResponse(
            400,
            "deviceId and baseUrls are required",
            origin,
          );
        }

        const updatedAt = Date.now();
        await ctx.runMutation(internal.mobile_bridge.upsertRegistration, {
          ownerId: owner.ownerId,
          deviceId,
          baseUrls,
          updatedAt,
          ...(platform ? { platform } : {}),
        });

        return jsonResponse(
          {
            ok: true,
            leaseDurationMs: MOBILE_BRIDGE_LEASE_MS,
            leaseExpiresAt: updatedAt + MOBILE_BRIDGE_LEASE_MS,
          },
          200,
          origin,
        );
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
    path: "/api/mobile/desktop-bridge/request",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const owner = await requireMobileAccountOwner(ctx, origin);
        if ("response" in owner) {
          return owner.response;
        }

        let body: {
          desktopDeviceId?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            desktopDeviceId?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const desktopDeviceId = normalizeDeviceId(body?.desktopDeviceId);
        if (!desktopDeviceId) {
          return errorResponse(400, "desktopDeviceId is required", origin);
        }

        const paired = await requirePairedMobileCredentials(ctx, request, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          origin,
        });
        if ("response" in paired) {
          return paired.response;
        }

        await ctx.runMutation(internal.mobile_access.upsertConnectIntent, {
          ownerId: owner.ownerId,
          desktopDeviceId,
          mobileDeviceId: paired.mobileDeviceId,
          createdAt: Date.now(),
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
            nowMs: Date.now(),
          },
        );
        if (!registration?.available) {
          return errorResponse(403, "Desktop bridge is unavailable", origin);
        }

        const paired = await requirePairedMobileCredentials(ctx, request, {
          ownerId: owner.ownerId,
          desktopDeviceId: deviceId,
          origin,
        });
        if ("response" in paired) {
          return paired.response;
        }

        await ctx.runMutation(internal.mobile_access.markPairedMobileSeen, {
          ownerId: owner.ownerId,
          desktopDeviceId: deviceId,
          mobileDeviceId: paired.mobileDeviceId,
          seenAt: Date.now(),
        });

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

        let body: { deviceId?: unknown } | null = null;
        try {
          body = (await request.json()) as { deviceId?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const deviceId =
          typeof body?.deviceId === "string" ? body.deviceId.trim() : "";
        if (!deviceId) {
          return errorResponse(400, "deviceId is required", origin);
        }

        try {
          const result = await ctx.runAction(
            internal.cloudflare_tunnels.getOrProvisionTunnel,
            { ownerId: owner.ownerId, deviceId },
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

  for (const path of ["/api/auth/link/send", "/api/auth/link/status"]) {
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
          typeof body?.email === "string"
            ? body.email.trim().toLowerCase()
            : "";
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
  // Exchanges the OTT for a session cookie server-side and stores the raw
  // Set-Cookie value so polling clients can apply it directly.
  http.route({
    path: "/api/auth/link/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionCookie = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          const headersList = (verifyRes as Record<string, unknown>)
            ?.headers as { _headersList?: [string, string][] } | undefined;
          if (Array.isArray(headersList?._headersList)) {
            for (const [name, value] of headersList._headersList) {
              if (name === "set-better-auth-cookie" || name === "set-cookie") {
                sessionCookie = value;
                break;
              }
            }
          }
        } catch (err) {
          console.error("[mobile/auth] Server-side OTT verify failed:", err);
        }
        await ctx.runMutation(internal.mobile_auth.completeLinkRequest, {
          requestId,
          ott,
          ...(sessionCookie ? { sessionCookie } : {}),
        });
      }

      const websiteUrl =
        process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });
};
