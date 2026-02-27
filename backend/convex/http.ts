import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { generateText, createGateway } from "ai";
import { buildSystemPrompt } from "./agent/prompt_builder";
import { eventsToHistoryMessages } from "./agent/history_messages";
import {
  computeAutoCompactionThresholdTokens,
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
  SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS,
} from "./agent/context_budget";
import {
  finalizeOrchestratorTurn,
  prepareOrchestratorTurn,
} from "./agent/orchestrator_turn";
import { createTools } from "./tools/index";
import { resolveModelConfig, resolveFallbackConfig } from "./agent/model_resolver";
import {
  streamTextWithFailover,
  usageSummaryFromFinish,
} from "./agent/model_execution";
import { beforeChat, afterChat } from "./agent/hooks";
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
import { verifyDiscordSignature } from "./channels/discord";
import { verifySlackSignature } from "./channels/slack";
import { verifyGoogleChatJwt } from "./channels/google_chat";
import { verifyTeamsToken } from "./channels/teams";
import { verifyLinqSignature } from "./channels/linq";

type ChatRequest = {
  conversationId: string;
  userMessageId: string;
  attachments?: Array<{
    id?: string;
    url?: string;
    mimeType?: string;
  }>;
  agent?: "orchestrator" | "general";
};

const getPlatformGuidance = (platform: string): string => {
  if (platform === "win32") {
    return `
## Platform: Windows

You are running on Windows. Use Windows-compatible commands:
- Shell: Git Bash (bash syntax works)
- Open apps: \`start <app>\` or \`cmd /c start "" <app>\` (NOT \`open -a\`)
- Open URLs: \`start <url>\`
- File paths: Use forward slashes in bash, or escape backslashes
- Common paths: \`$USERPROFILE\` (home), \`$APPDATA\`, \`$LOCALAPPDATA\`
`.trim();
  }

  if (platform === "darwin") {
    return `
## Platform: macOS

You are running on macOS. Use macOS-compatible commands:
- Shell: bash/zsh
- Open apps: \`open -a <app>\`
- Open URLs: \`open <url>\`
- Common paths: \`$HOME\`, \`~/Library/Application Support\`
`.trim();
  }

  if (platform === "linux") {
    return `
## Platform: Linux

You are running on Linux. Use Linux-compatible commands:
- Shell: bash
- Open apps: \`xdg-open\` or app-specific launchers
- Open URLs: \`xdg-open <url>\`
- Common paths: \`$HOME\`, \`~/.config\`, \`~/.local/share\`
`.trim();
  }

  return "";
};

const http = httpRouter();

authComponent.registerRoutes(http, createAuth, { cors: true });

const DEFAULT_CORS_ALLOWED_ORIGINS = [
  "http://localhost:5714",
  "https://fromyou.ai",
  "null",
];

const parseCorsOriginList = (rawValue: string | undefined): string[] =>
  (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const CORS_ALLOWED_ORIGINS = (() => {
  const configured = new Set<string>(DEFAULT_CORS_ALLOWED_ORIGINS);
  const siteUrl = process.env.SITE_URL;
  if (siteUrl) {
    configured.add(siteUrl);
  }
  const extraOrigins = parseCorsOriginList(process.env.CORS_ALLOWED_ORIGINS);
  for (const origin of extraOrigins) {
    configured.add(origin);
  }
  return configured;
})();

const isAllowedCorsOrigin = (origin: string | null) => {
  if (!origin) return true;
  if (origin.match(/^http:\/\/localhost(:\d+)?$/)) return true;
  return CORS_ALLOWED_ORIGINS.has(origin);
};

const getCorsHeaders = (origin: string | null) => {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Device-ID, X-Proxy-Token, X-Provider, X-Original-Path, X-Model-Id",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedCorsOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
};

const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  const cors = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const rejectDisallowedCorsOrigin = (request: Request): Response | null => {
  const origin = request.headers.get("origin");
  if (origin && !isAllowedCorsOrigin(origin)) {
    return new Response("CORS origin denied", { status: 403 });
  }
  return null;
};

const WEBHOOK_RATE_WINDOW_MS = 60_000;
const WEBHOOK_EVENT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const BRIDGE_REPLAY_WINDOW_MS = 5 * 60_000;
const BRIDGE_MAX_CLOCK_SKEW_SECONDS = 300;
const BRIDGE_NONCE_MAX_LENGTH = 128;

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const computeHmacSha256Hex = async (secret: string, message: string) => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(mac));
};

const verifyBridgeSignedRequest = async (
  request: Request,
  sessionSecret: string,
  rawBody: string,
): Promise<Response | { nonce: string }> => {
  const timestamp = request.headers.get("x-bridge-timestamp") ?? "";
  const nonce = request.headers.get("x-bridge-nonce") ?? "";
  const signature = request.headers.get("x-bridge-signature") ?? "";

  if (!timestamp || !nonce || !signature) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (nonce.length > BRIDGE_NONCE_MAX_LENGTH) {
    return new Response("Unauthorized", { status: 401 });
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > BRIDGE_MAX_CLOCK_SKEW_SECONDS
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const expected = await computeHmacSha256Hex(
    sessionSecret,
    `${timestamp}.${nonce}.${rawBody}`,
  );
  if (!constantTimeEqual(expected, signature)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return { nonce };
};

const rateLimitResponse = (retryAfterMs: number) =>
  new Response("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
    },
  });

const consumeWebhookDedup = async (
  ctx: Pick<ActionCtx, "runMutation">,
  scope: string,
  key: string | null | undefined,
): Promise<boolean> => {
  if (!key || key.trim().length === 0) {
    return true;
  }
  const status = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
    scope: `${scope}_dedup`,
    key,
    limit: 1,
    windowMs: WEBHOOK_EVENT_DEDUP_WINDOW_MS,
    blockMs: WEBHOOK_EVENT_DEDUP_WINDOW_MS,
  });
  return status.allowed;
};

type ConnectorAttachment = {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  size?: number;
  kind?: string;
};

const extractTelegramAttachments = (message: {
  photo?: Array<{ file_id?: string; file_size?: number }>;
  video?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
  document?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
  audio?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
  voice?: { file_id?: string; file_size?: number; mime_type?: string };
  sticker?: { file_id?: string; emoji?: string };
}) => {
  const attachments: ConnectorAttachment[] = [];

  const largestPhoto = message.photo && message.photo.length > 0
    ? message.photo[message.photo.length - 1]
    : undefined;
  if (largestPhoto?.file_id) {
    attachments.push({
      id: largestPhoto.file_id,
      kind: "image" as const,
      size: largestPhoto.file_size,
    });
  }
  if (message.video?.file_id) {
    attachments.push({
      id: message.video.file_id,
      name: message.video.file_name,
      mimeType: message.video.mime_type,
      size: message.video.file_size,
      kind: "video" as const,
    });
  }
  if (message.document?.file_id) {
    attachments.push({
      id: message.document.file_id,
      name: message.document.file_name,
      mimeType: message.document.mime_type,
      size: message.document.file_size,
      kind: "document" as const,
    });
  }
  if (message.audio?.file_id) {
    attachments.push({
      id: message.audio.file_id,
      name: message.audio.file_name,
      mimeType: message.audio.mime_type,
      size: message.audio.file_size,
      kind: "audio" as const,
    });
  }
  if (message.voice?.file_id) {
    attachments.push({
      id: message.voice.file_id,
      mimeType: message.voice.mime_type,
      size: message.voice.file_size,
      kind: "voice" as const,
    });
  }
  if (message.sticker?.file_id) {
    attachments.push({
      id: message.sticker.file_id,
      name: message.sticker.emoji,
      kind: "sticker" as const,
    });
  }

  return attachments;
};

const summarizeTelegramMessage = (message: {
  text?: string;
  caption?: string;
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
}) => {
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text;
  }
  if (typeof message.caption === "string" && message.caption.trim().length > 0) {
    return message.caption;
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) return "[Image]";
  if (message.video) return "[Video]";
  if (message.document) return "[Document]";
  if (message.audio) return "[Audio]";
  if (message.voice) return "[Voice message]";
  if (message.sticker) return "[Sticker]";
  return "";
};

const extractSlackAttachments = (files: unknown): ConnectorAttachment[] => {
  if (!Array.isArray(files)) return [];
  const attachments: ConnectorAttachment[] = [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const item = file as Record<string, unknown>;
    attachments.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      mimeType: typeof item.mimetype === "string" ? item.mimetype : undefined,
      url:
        typeof item.url_private_download === "string"
          ? item.url_private_download
          : typeof item.url_private === "string"
            ? item.url_private
            : undefined,
      size: typeof item.size === "number" ? item.size : undefined,
      kind: typeof item.filetype === "string" ? item.filetype : "file",
    });
  }
  return attachments;
};

const parseSlackTimestampMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 1000);
};

const inferSlackChatType = (
  channelType: string | undefined,
  channelId: string | undefined,
): string | undefined => {
  if (channelType && channelType.trim().length > 0) return channelType;
  if (!channelId) return undefined;
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  if (channelId.startsWith("C")) return "channel";
  return undefined;
};

const summarizeSlackMessage = (text: string | undefined, attachments: ConnectorAttachment[]) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 0) return trimmed;
  if (attachments.length === 0) return "";

  const first = attachments[0];
  const mime = (first?.mimeType ?? "").toLowerCase();
  const kind = (first?.kind ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "[Image]";
  if (mime.startsWith("video/")) return "[Video]";
  if (mime.startsWith("audio/") || kind.includes("audio") || kind.includes("voice")) {
    return "[Audio]";
  }
  if (mime === "application/pdf" || kind === "pdf") return "[PDF]";
  if (attachments.length === 1) return "[File]";
  return `[${attachments.length} attachments]`;
};

const parseIsoTimestampMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeGoogleChatUserId = (senderName: string | undefined) => {
  if (!senderName) return "";
  return senderName.startsWith("users/") ? senderName.slice(6) : senderName;
};

const extractGoogleChatAttachments = (attachments: unknown): ConnectorAttachment[] => {
  if (!Array.isArray(attachments)) return [];
  const result: ConnectorAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const item = attachment as Record<string, unknown>;
    const attachmentDataRef =
      item.attachmentDataRef && typeof item.attachmentDataRef === "object"
        ? (item.attachmentDataRef as Record<string, unknown>)
        : undefined;
    const id =
      typeof item.name === "string"
        ? item.name
        : typeof attachmentDataRef?.resourceName === "string"
          ? attachmentDataRef.resourceName
          : undefined;
    const mimeType =
      typeof item.contentType === "string" && item.contentType.length > 0
        ? item.contentType
        : undefined;
    const contentName =
      typeof item.contentName === "string" && item.contentName.length > 0
        ? item.contentName
        : undefined;
    const downloadUri =
      typeof item.downloadUri === "string" && item.downloadUri.length > 0
        ? item.downloadUri
        : typeof item.thumbnailUri === "string" && item.thumbnailUri.length > 0
          ? item.thumbnailUri
          : undefined;
    const kind = mimeType
      ? mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("audio/")
            ? "audio"
            : "file"
      : "file";
    result.push({
      id,
      name: contentName,
      mimeType,
      url: downloadUri,
      kind,
    });
  }
  return result;
};

const summarizeGoogleChatMessage = (text: string | undefined, attachments: ConnectorAttachment[]) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 0) return trimmed;
  if (attachments.length === 0) return "";

  const first = attachments[0];
  const mime = (first?.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "[Image]";
  if (mime.startsWith("video/")) return "[Video]";
  if (mime.startsWith("audio/")) return "[Audio]";
  if (attachments.length === 1) return "[Attachment]";
  return `[${attachments.length} attachments]`;
};

const extractTeamsAttachments = (attachments: unknown): ConnectorAttachment[] => {
  if (!Array.isArray(attachments)) return [];
  const result: ConnectorAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const item = attachment as Record<string, unknown>;
    const mimeType =
      typeof item.contentType === "string" && item.contentType.length > 0
        ? item.contentType
        : undefined;
    const kind = mimeType
      ? mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("audio/")
            ? "audio"
            : mimeType.includes("card")
              ? "card"
              : "file"
      : "file";
    result.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      mimeType,
      url: typeof item.contentUrl === "string" ? item.contentUrl : undefined,
      kind,
    });
  }
  return result;
};

const summarizeTeamsMessage = (text: string | undefined, attachments: ConnectorAttachment[]) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 0) return trimmed;
  if (attachments.length === 0) return "";

  const first = attachments[0];
  const mime = (first?.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "[Image]";
  if (mime.startsWith("video/")) return "[Video]";
  if (mime.startsWith("audio/")) return "[Audio]";
  if (attachments.length === 1) return "[Attachment]";
  return `[${attachments.length} attachments]`;
};

const parseDiscordSnowflakeTimestampMs = (snowflake: string | undefined): number | undefined => {
  if (!snowflake || !/^\d+$/.test(snowflake)) return undefined;
  try {
    return Number((BigInt(snowflake) >> 22n) + 1420070400000n);
  } catch {
    return undefined;
  }
};

const extractDiscordResolvedAttachments = (
  resolvedAttachments: unknown,
  requestedAttachmentId?: string,
): ConnectorAttachment[] => {
  if (!resolvedAttachments || typeof resolvedAttachments !== "object") {
    return [];
  }
  const entries = Object.entries(resolvedAttachments as Record<string, unknown>);
  const attachments: ConnectorAttachment[] = [];
  for (const [id, value] of entries) {
    if (requestedAttachmentId && id !== requestedAttachmentId) continue;
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const mimeType =
      typeof item.content_type === "string" && item.content_type.length > 0
        ? item.content_type
        : undefined;
    const kind = mimeType
      ? mimeType.startsWith("image/")
        ? "image"
        : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("audio/")
            ? "voice"
            : "file"
      : "file";
    attachments.push({
      id: typeof item.id === "string" ? item.id : id,
      name: typeof item.filename === "string" ? item.filename : undefined,
      mimeType,
      url:
        typeof item.url === "string"
          ? item.url
          : typeof item.proxy_url === "string"
            ? item.proxy_url
            : undefined,
      size: typeof item.size === "number" ? item.size : undefined,
      kind,
    });
  }
  return attachments;
};

const summarizeDiscordMessage = (text: string | undefined, attachments: ConnectorAttachment[]) => {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length > 0) return trimmed;
  if (attachments.length === 0) return "";

  const first = attachments[0];
  const mime = (first?.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "[Image]";
  if (mime.startsWith("video/")) return "[Video]";
  if (mime.startsWith("audio/")) return "[Voice message]";
  if (attachments.length === 1) return "[Attachment]";
  return `[${attachments.length} attachments]`;
};

const extractLinqAttachments = (parts: unknown): ConnectorAttachment[] => {
  if (!Array.isArray(parts)) return [];
  const attachments: ConnectorAttachment[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "text") continue;
    const value = typeof item.value === "string" ? item.value : undefined;
    const mimeType = typeof item.mime_type === "string" ? item.mime_type : undefined;
    const inferredKind = type.toLowerCase();
    attachments.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      mimeType,
      url:
        value && (value.startsWith("http://") || value.startsWith("https://"))
          ? value
          : typeof item.url === "string"
            ? item.url
            : undefined,
      kind: inferredKind || "file",
    });
  }
  return attachments;
};

const summarizeLinqMessage = (text: string, attachments: ConnectorAttachment[]) => {
  const trimmed = text.trim();
  if (trimmed.length > 0) return trimmed;
  if (attachments.length === 0) return "";

  const firstKind = (attachments[0]?.kind ?? "").toLowerCase();
  if (firstKind.includes("image") || firstKind.includes("photo")) return "[Image]";
  if (firstKind.includes("video")) return "[Video]";
  if (firstKind.includes("audio") || firstKind.includes("voice")) return "[Audio]";
  if (attachments.length === 1) return "[Attachment]";
  return `[${attachments.length} attachments]`;
};

type ChannelEventKind = "message" | "reaction" | "edit" | "delete" | "system";

const isChannelEventKind = (value: string | undefined): value is ChannelEventKind =>
  value === "message" ||
  value === "reaction" ||
  value === "edit" ||
  value === "delete" ||
  value === "system";

const extractBridgeAttachments = (attachments: unknown): ConnectorAttachment[] => {
  if (!Array.isArray(attachments)) return [];
  const result: ConnectorAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const item = attachment as Record<string, unknown>;
    result.push({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
      size: typeof item.size === "number" ? item.size : undefined,
      kind: typeof item.kind === "string" ? item.kind : "file",
    });
  }
  return result;
};

const normalizeBridgeReactions = (reactions: unknown) => {
  if (!Array.isArray(reactions)) return [];
  return reactions
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      emoji: typeof entry.emoji === "string" ? entry.emoji : "",
      action: entry.action === "remove" ? ("remove" as const) : ("add" as const),
      targetMessageId:
        typeof entry.targetMessageId === "string" ? entry.targetMessageId : undefined,
    }))
    .filter((entry) => entry.emoji.length > 0);
};

http.route({
  path: "/api/chat",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
});

http.route({
  path: "/api/chat",
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
      await assertSensitiveSessionPolicyAction(ctx, identity);
    } catch {
      return withCors(new Response("Unauthorized", { status: 401 }), origin);
    }
    let body: ChatRequest | null = null;
    try {
      body = (await request.json()) as ChatRequest;
    } catch {
      return withCors(new Response("Invalid JSON body", { status: 400 }), origin);
    }

    if (!body?.conversationId || !body?.userMessageId) {
      return withCors(
        new Response("conversationId and userMessageId are required", {
          status: 400,
        }),
        origin,
      );
    }

    const conversationId = body.conversationId as Id<"conversations">;
    const userMessageId = body.userMessageId as Id<"events">;

    let conversation: Doc<"conversations"> | null = null;
    try {
      conversation = await requireConversationOwnerAction(ctx, conversationId);
    } catch {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }
    if (!conversation) {
      return withCors(new Response("Conversation not found", { status: 404 }), origin);
    }

    const userEvent = await ctx.runQuery(internal.events.getById, {
      id: userMessageId,
    });
    if (!userEvent || userEvent.type !== "user_message") {
      return withCors(new Response("User message not found", { status: 404 }), origin);
    }

    if (userEvent.conversationId !== conversationId) {
      return withCors(new Response("Conversation mismatch", { status: 400 }), origin);
    }

    const executionTarget = await ctx.runQuery(
      internal.agent.device_resolver.resolveExecutionTarget,
      { ownerId: conversation.ownerId },
    );
    // Prefer live device/cloud resolution; fall back to message deviceId for startup race windows.
    const targetDeviceId = executionTarget.targetDeviceId ?? userEvent.deviceId ?? undefined;
    const spriteName = targetDeviceId ? undefined : executionTarget.spriteName ?? undefined;
    if (spriteName) {
      await ctx.runMutation(internal.agent.cloud_devices.touchActivity, {
        ownerId: conversation.ownerId,
      });
    }

    const userPayload =
      userEvent.payload && typeof userEvent.payload === "object"
        ? (userEvent.payload as { text?: string; platform?: string })
        : {};
    const userText = userPayload.text ?? "";
    const userPlatform = userPayload.platform ?? "unknown";
    const agentType =
      body.agent === "general"
        ? "general"
        : "orchestrator";

    const attachments = body.attachments ?? [];
    const resolvedImages: Array<{ url: string; mimeType?: string }> = [];
    for (const attachment of attachments) {
      if (attachment.id) {
        const record = await ctx.runQuery(internal.data.attachments.getById, {
          id: attachment.id as Id<"attachments">,
        });
        if (record) {
          const storageUrl =
            record.url ??
            (await ctx.storage.getUrl(record.storageKey as Id<"_storage">));
          if (storageUrl) {
            resolvedImages.push({
              url: storageUrl,
              mimeType: record.mimeType ?? undefined,
            });
          }
        }
        continue;
      }
      if (attachment.url) {
        resolvedImages.push({
          url: attachment.url,
          mimeType: attachment.mimeType,
        });
      }
    }

    await ctx.runMutation(internal.agent.agents.ensureBuiltins, {});
    await ctx.runMutation(internal.data.skills.ensureBuiltinSkills, {});
    const resolvedConfig = await resolveModelConfig(ctx, agentType, conversation.ownerId);
    const fallbackConfig = await resolveFallbackConfig(ctx, agentType, conversation.ownerId).catch(() => null);

    const activeThreadId = await ctx.runQuery(internal.conversations.getActiveThreadId, { conversationId });

    // Fallback to active thread if orchestrator or if no message ID provided
    const targetThreadId = activeThreadId;
    const platformGuidance = getPlatformGuidance(userPlatform);
    let promptBuild: Awaited<ReturnType<typeof buildSystemPrompt>>;
    let requestMessages: any[];
    let orchestratorTurn:
      | Awaited<ReturnType<typeof prepareOrchestratorTurn>>
      | null = null;

    if (agentType === "orchestrator") {
      orchestratorTurn = await prepareOrchestratorTurn(ctx, {
        conversation,
        conversationId,
        ownerId: conversation.ownerId,
        activeThreadId,
        userPayload: {
          kind: "chat",
          text: userText,
          images: resolvedImages,
          platformGuidance,
        },
        history: {
          enabled: true,
          beforeTimestamp: userEvent.timestamp,
          excludeEventId: userMessageId,
          microcompact: {
            trigger: "auto",
            modelForWarningThreshold:
              typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
          },
        },
      });
      promptBuild = orchestratorTurn.promptBuild;
      requestMessages = orchestratorTurn.messages;
    } else {
      promptBuild = await buildSystemPrompt(ctx, agentType, {
        ownerId: conversation.ownerId,
        conversationId,
      });
      const historyEvents = await ctx.runQuery(
        internal.events.listRecentContextEventsByTokens,
        {
          conversationId,
          beforeTimestamp: userEvent.timestamp,
          excludeEventId: userMessageId,
          contextAgentType: agentType,
        },
      );
      const historyBuild = eventsToHistoryMessages(historyEvents, {
        microcompact: {
          trigger: "auto",
          warningThresholdTokens: computeAutoCompactionThresholdTokens(
            typeof resolvedConfig.model === "string" ? resolvedConfig.model : undefined,
          ),
        },
      });
      if (historyBuild.microcompactBoundary) {
        try {
          await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId,
            type: "microcompact_boundary",
            payload: {
              ...historyBuild.microcompactBoundary,
              agentType,
            },
          });
        } catch {
          // Best effort: microcompact bookkeeping should never block chat.
        }
      }

      const contentParts: Array<
        { type: "text"; text: string } | { type: "image"; image: URL; mediaType?: string }
      > = [];
      const trimmedText = userText.trim();
      if (trimmedText.length > 0) {
        contentParts.push({ type: "text", text: trimmedText });
      }
      for (const image of resolvedImages) {
        try {
          contentParts.push({
            type: "image",
            image: new URL(image.url),
            mediaType: image.mimeType,
          });
        } catch {
          // Ignore invalid URLs.
        }
      }
      if (contentParts.length === 0) {
        contentParts.push({ type: "text", text: " " });
      }

      const contextParts: string[] = [];
      if (promptBuild.dynamicContext) contextParts.push(promptBuild.dynamicContext);
      if (platformGuidance) contextParts.push(platformGuidance);
      if (contextParts.length > 0) {
        contentParts.push({
          type: "text",
          text: `\n\n<system-context>\n${contextParts.join("\n\n")}\n</system-context>`,
        });
      }

      requestMessages = [
        ...historyBuild.messages,
        {
          role: "user",
          content: contentParts,
        },
      ];
    }

    // --- beforeChat hook: rate limiting ---
    const beforeResult = await beforeChat(ctx, {
      ownerId: conversation.ownerId,
      conversationId,
      agentType,
      modelString: resolvedConfig.model as string,
    });
    if (!beforeResult.allowed) {
      return withCors(rateLimitResponse(beforeResult.retryAfterMs ?? 60_000), origin);
    }

    const chatStartTime = Date.now();

    const streamTextSharedArgs = {
      system: promptBuild.systemPrompt,
      tools: createTools(
        ctx,
        targetDeviceId
          ? {
              conversationId,
              userMessageId,
              targetDeviceId,
              agentType,
              sourceDeviceId: userEvent.deviceId,
            }
          : undefined,
        {
          agentType,
          toolsAllowlist: promptBuild.toolsAllowlist,
          maxTaskDepth: promptBuild.maxTaskDepth,
          ownerId: conversation.ownerId,
          conversationId,
          userMessageId,
          targetDeviceId,
          spriteName,
        },
      ),
      messages: requestMessages,
      abortSignal: request.signal,
      onFinish: async ({ text, usage, totalUsage, response }: { text: string; usage: any; totalUsage: any; response: any }) => {
        const usageSummary = usageSummaryFromFinish(usage, totalUsage);

        if (agentType === "orchestrator" && orchestratorTurn) {
          await finalizeOrchestratorTurn(ctx, {
            conversationId,
            ownerId: conversation.ownerId,
            userMessageId,
            activeThreadId: orchestratorTurn.activeThreadId,
            threadUserMessage: orchestratorTurn.threadUserMessage,
            responseMessages: response?.messages,
            assistantText: text,
            usage: usageSummary,
            reminderState: orchestratorTurn.reminderState,
            afterChat: {
              modelString: resolvedConfig.model as string,
              durationMs: Date.now() - chatStartTime,
              success: true,
            },
          });
          return;
        }

        if (text.trim().length > 0) {
          await ctx.runMutation(internal.events.saveAssistantMessage, {
            conversationId,
            text,
            userMessageId,
            usage: usageSummary,
          });
        }

        if (targetThreadId) {
          const messagesToSave: Array<{
            role: string;
            content: string;
            toolCallId?: string;
            tokenEstimate?: number;
          }> = [
            { role: "user", content: userText },
          ];

          if (response?.messages) {
            for (const msg of response.messages) {
              const rawToolCallId = (msg as { toolCallId?: unknown }).toolCallId;
              const toolCallId = typeof rawToolCallId === "string" 
                ? rawToolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) 
                : undefined;
              
              messagesToSave.push({
                role: msg.role,
                content: JSON.stringify({
                  role: msg.role,
                  content: msg.content,
                  ...(toolCallId ? { toolCallId } : {}),
                }),
                ...(toolCallId ? { toolCallId } : {}),
              });
            }
          }

          if (messagesToSave.length > 1) {
            await ctx.runMutation(internal.data.threads.saveThreadMessages, {
              ownerId: conversation.ownerId,
              threadId: targetThreadId,
              messages: messagesToSave,
            });

            const updatedThread = await ctx.runQuery(internal.data.threads.getThreadById, {
              threadId: targetThreadId,
            });
            const compactionThresholdTokens = agentType === "orchestrator"
              ? ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
              : SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS;
            if (
              (updatedThread?.totalTokenEstimate ?? 0) >=
              compactionThresholdTokens
            ) {
              await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
                threadId: targetThreadId,
              });
            }
          }
        }

        await afterChat(ctx, {
          ownerId: conversation.ownerId,
          conversationId,
          agentType,
          modelString: resolvedConfig.model as string,
          usage: usageSummary,
          durationMs: Date.now() - chatStartTime,
          success: true,
        });

        // Best-effort command suggestions after each response.
        try {
          await ctx.scheduler.runAfter(0, internal.agent.suggestions.generateSuggestions, {
            conversationId,
            ownerId: conversation.ownerId,
          });
        } catch { /* best-effort */ }
      },
    };

    const result = await streamTextWithFailover({
      resolvedConfig: resolvedConfig as Record<string, unknown>,
      fallbackConfig: (fallbackConfig ?? undefined) as Record<string, unknown> | undefined,
      sharedArgs: streamTextSharedArgs as Record<string, unknown>,
    });

    const response = result.toUIMessageStreamResponse();
    return withCors(response, origin);
  }),
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
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
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
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
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
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request.headers.get("origin")),
    });
  }),
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
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
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
  handler: httpAction(async (_ctx, request) => {
    const rejection = rejectDisallowedCorsOrigin(request);
    if (rejection) return rejection;
    const origin = request.headers.get("origin");
    return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
  }),
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

// ---------------------------------------------------------------------------
// Telegram Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Verify webhook secret
    const secret = request.headers.get("x-telegram-bot-api-secret-token");
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expectedSecret || !secret || !constantTimeEqual(secret, expectedSecret)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: {
      update_id?: number;
      message?: {
        chat?: { id?: number; type?: string };
        from?: { id?: number; first_name?: string; username?: string };
        text?: string;
        caption?: string;
        message_id?: number;
        photo?: Array<{ file_id?: string; file_size?: number }>;
        video?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        document?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        audio?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        voice?: { file_id?: string; file_size?: number; mime_type?: string };
        sticker?: { file_id?: string; emoji?: string };
      };
      edited_message?: {
        chat?: { id?: number; type?: string };
        from?: { id?: number; first_name?: string; username?: string };
        text?: string;
        caption?: string;
        message_id?: number;
        photo?: Array<{ file_id?: string; file_size?: number }>;
        video?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        document?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        audio?: { file_id?: string; file_size?: number; mime_type?: string; file_name?: string };
        voice?: { file_id?: string; file_size?: number; mime_type?: string };
        sticker?: { file_id?: string; emoji?: string };
      };
      message_reaction?: {
        chat?: { id?: number; type?: string };
        user?: { id?: number; first_name?: string; username?: string };
        message_id?: number;
        old_reaction?: Array<{ emoji?: string }>;
        new_reaction?: Array<{ emoji?: string }>;
      };
    };
    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const telegramDedupKey =
      typeof update.update_id === "number"
        ? `update:${update.update_id}`
        : undefined;
    const telegramDedupAllowed = await consumeWebhookDedup(ctx, "telegram", telegramDedupKey);
    if (!telegramDedupAllowed) {
      return new Response("OK", { status: 200 });
    }

    const message = update.message ?? update.edited_message;
    if (message?.chat?.id && message.from?.id) {
      const chatId = String(message.chat.id);
      const telegramUserId = String(message.from.id);
      const text = summarizeTelegramMessage(message);
      const attachments = extractTelegramAttachments(message);
      const displayName = message.from.first_name ?? message.from.username ?? undefined;
      const groupId = message.chat.type === "private" ? undefined : chatId;

      if (!text && attachments.length === 0) {
        return new Response("OK", { status: 200 });
      }

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "telegram",
        key: telegramUserId,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      const envelopeKind: "edit" | "message" = update.edited_message ? "edit" : "message";
      const envelope = {
        provider: "telegram",
        kind: envelopeKind,
        chatType: message.chat.type,
        externalUserId: telegramUserId,
        externalChatId: chatId,
        externalMessageId:
          typeof message.message_id === "number" ? String(message.message_id) : undefined,
        text,
        attachments,
      };

      if (!update.edited_message && text.startsWith("/start")) {
        const codeArg = text.slice("/start".length).trim() || undefined;
        await ctx.scheduler.runAfter(0, internal.channels.telegram.handleStartCommand, {
          chatId,
          telegramUserId,
          codeArg,
          displayName,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.channels.telegram.handleIncomingMessage, {
          chatId,
          telegramUserId,
          text,
          displayName,
          groupId,
          attachments,
          channelEnvelope: envelope,
        });
      }

      // Return 200 immediately (non-blocking)
      return new Response("OK", { status: 200 });
    }

    const reaction = update.message_reaction;
    if (reaction?.chat?.id && reaction.user?.id) {
      const chatId = String(reaction.chat.id);
      const telegramUserId = String(reaction.user.id);
      const groupId = reaction.chat.type === "private" ? undefined : chatId;
      const oldEmojis = (reaction.old_reaction ?? [])
        .map((entry) => entry.emoji)
        .filter((emoji): emoji is string => typeof emoji === "string" && emoji.length > 0);
      const newEmojis = (reaction.new_reaction ?? [])
        .map((entry) => entry.emoji)
        .filter((emoji): emoji is string => typeof emoji === "string" && emoji.length > 0);

      const summary = `Telegram reaction update on message ${reaction.message_id ?? "unknown"}: ${oldEmojis.join(", ") || "none"} -> ${newEmojis.join(", ") || "none"}`;

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "telegram",
        key: `${telegramUserId}:reaction`,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.telegram.handleIncomingMessage, {
        chatId,
        telegramUserId,
        text: summary,
        groupId,
        channelEnvelope: {
          provider: "telegram",
          kind: "reaction" as const,
          chatType: reaction.chat.type,
          externalUserId: telegramUserId,
          externalChatId: chatId,
          externalMessageId:
            typeof reaction.message_id === "number" ? String(reaction.message_id) : undefined,
          reactions: [
            ...oldEmojis.map((emoji) => ({ emoji, action: "remove" as const, targetMessageId: typeof reaction.message_id === "number" ? String(reaction.message_id) : undefined })),
            ...newEmojis.map((emoji) => ({ emoji, action: "add" as const, targetMessageId: typeof reaction.message_id === "number" ? String(reaction.message_id) : undefined })),
          ],
        },
        respond: false,
      });
    }

    // Return 200 immediately (non-blocking)
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Discord Interactions Endpoint
// ---------------------------------------------------------------------------

// Discord interaction types
const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_TIMESTAMP_MAX_SKEW_SECONDS = 5 * 60;

// Discord interaction response types
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;

http.route({
  path: "/api/discord/interactions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) {
      console.error("[discord] Missing DISCORD_PUBLIC_KEY");
      return new Response("Server configuration error", { status: 500 });
    }

    // 1. Ed25519 signature verification
    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const rawBody = await request.text();

    if (!signature || !timestamp) {
      return new Response("Missing signature headers", { status: 401 });
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isFinite(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > DISCORD_TIMESTAMP_MAX_SKEW_SECONDS
    ) {
      return new Response("Stale request timestamp", { status: 401 });
    }

    const isValid = await verifyDiscordSignature(rawBody, signature, timestamp, publicKey);
    if (!isValid) {
      return new Response("Invalid signature", { status: 401 });
    }

    // 2. Parse the interaction
    let interaction: {
      type: number;
      id: string;
      token: string;
      application_id: string;
      guild_id?: string;
      channel_id?: string;
      data?: {
        name?: string;
        options?: Array<{ name: string; value: string | number | boolean }>;
        resolved?: {
          attachments?: Record<
            string,
            {
              id?: string;
              filename?: string;
              content_type?: string;
              size?: number;
              url?: string;
              proxy_url?: string;
            }
          >;
        };
      };
      user?: { id: string; username?: string; global_name?: string };
      member?: { user?: { id: string; username?: string; global_name?: string } };
    };
    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 3. Handle PING (Discord verification check)
    if (interaction.type === INTERACTION_PING) {
      return new Response(JSON.stringify({ type: RESPONSE_PONG }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Handle slash commands
    if (interaction.type === INTERACTION_APPLICATION_COMMAND) {
      const commandName = interaction.data?.name;
      const options = interaction.data?.options ?? [];
      // User can be top-level (DM) or nested under member (guild)
      const user = interaction.user ?? interaction.member?.user;
      const discordUserId = user?.id ?? "";
      const displayName = user?.global_name ?? user?.username ?? undefined;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      if (commandName !== "status") {
        const dedupAllowed = await consumeWebhookDedup(
          ctx,
          "discord",
          `interaction:${interaction.id}`,
        );
        if (!dedupAllowed) {
          return new Response(
            JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      if (commandName === "status") {
        // Status is fast enough to respond immediately
        const connection = discordUserId
          ? await ctx.runQuery(internal.channels.utils.getConnectionByProviderAndExternalId, {
              provider: "discord",
              externalUserId: discordUserId,
            })
          : null;

        const statusText = connection
          ? `Connected to Stella (linked ${new Date(connection.linkedAt).toLocaleDateString()}). Use \`/ask\` to chat.`
          : "Not linked. Use `/link` with your 6-digit code from Stella Settings.";

        return new Response(
          JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE, data: { content: statusText } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (commandName === "link") {
        const codeRaw = options.find((o) => o.name === "code")?.value;
        const codeArg = typeof codeRaw === "string" ? codeRaw : String(codeRaw ?? "");

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "discord",
          key: `${discordUserId}:link`,
          limit: 30,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        // Defer response (shows "thinking...")
        // Schedule the actual work as an internal action
        await ctx.scheduler.runAfter(0, internal.channels.discord.handleLinkCommand, {
          applicationId,
          interactionToken,
          discordUserId,
          codeArg,
          displayName,
        });

        return new Response(
          JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (commandName === "ask") {
        const messageRaw = options.find((o) => o.name === "message")?.value;
        const message =
          typeof messageRaw === "string" ? messageRaw.trim() : String(messageRaw ?? "").trim();
        const attachmentOption = options.find((o) => o.name === "attachment")?.value;
        const attachmentId = typeof attachmentOption === "string" ? attachmentOption : undefined;
        const attachments = extractDiscordResolvedAttachments(
          interaction.data?.resolved?.attachments,
          attachmentId,
        );
        const text = summarizeDiscordMessage(message, attachments);

        if (!text && attachments.length === 0) {
          return new Response(
            JSON.stringify({
              type: RESPONSE_CHANNEL_MESSAGE,
              data: { content: "Please provide a message or attachment. Usage: `/ask message:...`" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "discord",
          key: `${discordUserId}:ask`,
          limit: 20,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        // Defer response and process async
        const chatType = interaction.guild_id ? "guild" : "dm";
        const groupId =
          interaction.guild_id && interaction.channel_id
            ? `guild:${interaction.guild_id}:channel:${interaction.channel_id}`
            : interaction.guild_id
              ? `guild:${interaction.guild_id}`
              : undefined;
        const channelEnvelope = {
          provider: "discord",
          kind: "message" as const,
          chatType,
          externalUserId: discordUserId,
          externalChatId: interaction.channel_id,
          externalMessageId: interaction.id,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          sourceTimestamp: parseDiscordSnowflakeTimestampMs(interaction.id) ?? Date.now(),
        };

        await ctx.scheduler.runAfter(0, internal.channels.discord.handleAskCommand, {
          applicationId,
          interactionToken,
          discordUserId,
          text,
          displayName,
          groupId,
          ...(attachments.length > 0 ? { attachments } : {}),
          channelEnvelope,
        });

        return new Response(
          JSON.stringify({ type: RESPONSE_DEFERRED_CHANNEL_MESSAGE }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Unknown command
      return new Response(
        JSON.stringify({
          type: RESPONSE_CHANNEL_MESSAGE,
          data: { content: "Unknown command." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Unhandled interaction type
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Slack OAuth Callback
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildSlackResultPage = (success: boolean, message: string): string => {
  const title = success ? "Stella Installed" : "Installation Failed";
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${safeTitle}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { text-align: center; padding: 3rem; max-width: 400px; }
  .icon { font-size: 4rem; color: ${color}; margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #a3a3a3; line-height: 1.6; }
</style>
</head>
<body><div class="card"><div class="icon">${icon}</div><h1>${safeTitle}</h1><p>${safeMessage}</p></div></body>
</html>`;
};

http.route({
  path: "/api/slack/oauth_callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");

    if (!state) {
      return new Response(buildSlackResultPage(false, "Missing OAuth state."), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    const consumedState = await ctx.runMutation(
      internal.data.integrations.consumeSlackOAuthState,
      { state },
    );
    if (!consumedState) {
      return new Response(
        buildSlackResultPage(false, "Invalid or expired OAuth state. Please retry installation."),
        {
          status: 400,
          headers: { "Content-Type": "text/html" },
        },
      );
    }

    if (error) {
      return new Response(buildSlackResultPage(false, "Installation was cancelled."), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }

    if (!code) {
      return new Response(buildSlackResultPage(false, "Missing authorization code."), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error("[slack-oauth] Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET");
      return new Response(buildSlackResultPage(false, "Server configuration error."), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }

    try {
      const redirectUri = `${process.env.CONVEX_SITE_URL}/api/slack/oauth_callback`;
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      });

      const tokenData = await tokenRes.json() as {
        ok: boolean;
        error?: string;
        access_token?: string;
        bot_user_id?: string;
        scope?: string;
        team?: { id?: string; name?: string };
        authed_user?: { id?: string };
      };

      if (!tokenData.ok) {
        const slackError = tokenData.error?.trim() || "unknown_error";
        console.error("[slack-oauth] Token exchange failed:", slackError);
        return new Response(
          buildSlackResultPage(false, `Slack error: ${slackError}`),
          { status: 400, headers: { "Content-Type": "text/html" } },
        );
      }

      await ctx.runMutation(internal.channels.slack_installations.upsert, {
        teamId: tokenData.team?.id ?? "",
        teamName: tokenData.team?.name,
        botToken: tokenData.access_token ?? "",
        botUserId: tokenData.bot_user_id,
        scope: tokenData.scope,
        installedBy: tokenData.authed_user?.id,
      });

      const teamName = tokenData.team?.name ?? "your workspace";
      return new Response(
        buildSlackResultPage(true, `Stella has been installed in ${teamName}! You can close this tab and DM @Stella to get started.`),
        { status: 200, headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      console.error("[slack-oauth] Error:", err);
      return new Response(
        buildSlackResultPage(false, "An unexpected error occurred during installation."),
        { status: 500, headers: { "Content-Type": "text/html" } },
      );
    }
  }),
});

// ---------------------------------------------------------------------------
// Slack Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/slack",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      console.error("[slack] Missing SLACK_SIGNING_SECRET");
      return new Response("Server configuration error", { status: 500 });
    }

    const rawBody = await request.text();
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";

    const isValid = await verifySlackSignature(rawBody, timestamp, signature, signingSecret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: {
      type?: string;
      challenge?: string;
      team_id?: string;
      event_id?: string;
      event?: {
        type?: string;
        subtype?: string;
        bot_id?: string;
        hidden?: boolean;
        channel_type?: string;
        text?: string;
        user?: string;
        channel?: string;
        ts?: string;
        event_ts?: string;
        files?: unknown;
        deleted_ts?: string;
        message?: {
          type?: string;
          subtype?: string;
          user?: string;
          text?: string;
          channel?: string;
          channel_type?: string;
          ts?: string;
          files?: unknown;
        };
        previous_message?: {
          user?: string;
          text?: string;
          ts?: string;
          files?: unknown;
        };
        reaction?: string;
        item?: {
          type?: string;
          channel?: string;
          ts?: string;
        };
      };
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Handle URL verification challenge (Slack setup requirement)
    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle event callbacks
    if (payload.type === "event_callback") {
      const event = payload.event;
      if (!event) {
        return new Response("OK", { status: 200 });
      }

      const slackDedupAllowed = await consumeWebhookDedup(
        ctx,
        "slack",
        payload.event_id ? `event:${payload.event_id}` : undefined,
      );
      if (!slackDedupAllowed) {
        return new Response("OK", { status: 200 });
      }

      if (event.type === "message" && !event.bot_id) {
        const subtype = event.subtype ?? "";
        let slackUserId = event.user ?? "";
        let channelId = event.channel ?? "";
        let channelType = inferSlackChatType(event.channel_type, channelId);
        let messageTs = event.ts;
        let attachments = extractSlackAttachments(event.files);
        let text = summarizeSlackMessage(event.text, attachments);
        let kind: "message" | "edit" | "delete" = "message";
        let respond = true;

        if (subtype === "message_changed") {
          const changed = event.message;
          kind = "edit";
          respond = false;
          slackUserId = changed?.user ?? slackUserId;
          channelId = changed?.channel ?? channelId;
          channelType = inferSlackChatType(changed?.channel_type ?? channelType, channelId);
          messageTs = changed?.ts ?? event.ts;
          attachments = extractSlackAttachments(changed?.files);
          text = summarizeSlackMessage(changed?.text, attachments);
        } else if (subtype === "message_deleted") {
          const previous = event.previous_message;
          kind = "delete";
          respond = false;
          slackUserId = previous?.user ?? slackUserId;
          messageTs = event.deleted_ts ?? previous?.ts ?? event.ts;
          attachments = extractSlackAttachments(previous?.files);
          text = summarizeSlackMessage(previous?.text, attachments);
        } else if (subtype && subtype !== "file_share") {
          return new Response("OK", { status: 200 });
        }

        if (!slackUserId || !channelId) {
          return new Response("OK", { status: 200 });
        }

        if (!text && attachments.length === 0 && kind === "message") {
          return new Response("OK", { status: 200 });
        }

        if (!text) {
          if (kind === "edit") {
            text = `Slack edited message ${messageTs ?? "unknown"}`;
          } else if (kind === "delete") {
            text = `Slack deleted message ${messageTs ?? "unknown"}`;
          }
        }

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "slack",
          key: kind === "message" ? slackUserId : `${slackUserId}:${kind}`,
          limit: 30,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        const groupId = channelType === "im" ? undefined : channelId;
        const envelope = {
          provider: "slack",
          kind,
          chatType: channelType,
          externalUserId: slackUserId,
          externalChatId: channelId,
          externalMessageId: messageTs,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          sourceTimestamp: parseSlackTimestampMs(event.event_ts ?? messageTs),
        };

        if (respond && channelType === "im" && text.toLowerCase().startsWith("link ")) {
          await ctx.scheduler.runAfter(0, internal.channels.slack.handleLinkCommand, {
            slackUserId,
            channelId,
            code: text.slice(5).trim(),
            teamId: payload.team_id,
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.channels.slack.handleIncomingMessage, {
            slackUserId,
            channelId,
            text,
            teamId: payload.team_id,
            groupId,
            ...(attachments.length > 0 ? { attachments } : {}),
            channelEnvelope: envelope,
            ...(respond ? {} : { respond: false }),
          });
        }
      } else if (
        (event.type === "reaction_added" || event.type === "reaction_removed") &&
        event.item?.type === "message"
      ) {
        const slackUserId = event.user ?? "";
        const channelId = event.item.channel ?? "";
        const targetMessageId = event.item.ts;
        const reaction = (event.reaction ?? "").trim();
        if (!slackUserId || !channelId || !reaction) {
          return new Response("OK", { status: 200 });
        }

        const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
          scope: "slack",
          key: `${slackUserId}:reaction`,
          limit: 30,
          windowMs: WEBHOOK_RATE_WINDOW_MS,
          blockMs: WEBHOOK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return rateLimitResponse(rateLimit.retryAfterMs);
        }

        const chatType = inferSlackChatType(event.channel_type, channelId);
        const groupId = chatType === "im" ? undefined : channelId;
        const action = event.type === "reaction_added" ? "add" : "remove";
        const summary = `Slack reaction ${action === "add" ? "added" : "removed"}: :${reaction}: on message ${targetMessageId ?? "unknown"}`;

        await ctx.scheduler.runAfter(0, internal.channels.slack.handleIncomingMessage, {
          slackUserId,
          channelId,
          text: summary,
          teamId: payload.team_id,
          groupId,
          channelEnvelope: {
            provider: "slack",
            kind: "reaction" as const,
            chatType,
            externalUserId: slackUserId,
            externalChatId: channelId,
            externalMessageId: targetMessageId,
            text: summary,
            reactions: [
              {
                emoji: reaction,
                action,
                targetMessageId,
              },
            ],
            sourceTimestamp: parseSlackTimestampMs(event.event_ts ?? targetMessageId),
          },
          respond: false,
        });
      }
    }

    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Google Chat Webhook
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/google_chat",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const projectNumber = process.env.GOOGLE_CHAT_PROJECT_NUMBER;
    if (!projectNumber) {
      console.error("[google_chat] Missing GOOGLE_CHAT_PROJECT_NUMBER");
      return new Response("Server configuration error", { status: 500 });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const isValid = await verifyGoogleChatJwt(authHeader, projectNumber);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let event: {
      type?: string;
      eventType?: string;
      eventTime?: string;
      message?: {
        name?: string;
        sender?: { name?: string; displayName?: string; type?: string };
        argumentText?: string;
        text?: string;
        thread?: { name?: string };
        attachment?: Array<{
          name?: string;
          contentName?: string;
          contentType?: string;
          thumbnailUri?: string;
          downloadUri?: string;
          source?: string;
          attachmentDataRef?: { resourceName?: string; attachmentUploadToken?: string };
        }>;
      };
      reaction?: {
        user?: { name?: string; displayName?: string };
        emoji?: { unicode?: string };
      };
      user?: { name?: string; displayName?: string };
      space?: { name?: string; type?: string; displayName?: string };
    };
    try {
      event = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const eventType = (event.type ?? event.eventType ?? "").toUpperCase();
    if (eventType === "MESSAGE") {
      const spaceName = event.space?.name ?? "";
      const spaceType = (event.space?.type ?? "").toLowerCase();
      const groupId = spaceType && spaceType !== "dm" ? spaceName : undefined;
      const sender = event.message?.sender ?? event.user;
      const googleUserId = normalizeGoogleChatUserId(sender?.name);
      const displayName = sender?.displayName;
      const attachments = extractGoogleChatAttachments(event.message?.attachment);
      const rawText = event.message?.argumentText ?? event.message?.text;
      const text = summarizeGoogleChatMessage(rawText, attachments);

      if (!spaceName || !googleUserId) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const messageDedupKey = event.message?.name
        ? `message:${spaceName}:${googleUserId}:${event.message.name}`
        : event.eventTime
          ? `message:${spaceName}:${googleUserId}:${event.eventTime}`
          : undefined;
      const googleMessageDedupAllowed = await consumeWebhookDedup(
        ctx,
        "google_chat",
        messageDedupKey,
      );
      if (!googleMessageDedupAllowed) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!text && attachments.length === 0) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "google_chat",
        key: googleUserId,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      const envelope = {
        provider: "google_chat",
        kind: "message" as const,
        chatType: spaceType || undefined,
        externalUserId: googleUserId,
        externalChatId: spaceName,
        externalMessageId: event.message?.name,
        threadId: event.message?.thread?.name,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        sourceTimestamp: parseIsoTimestampMs(event.eventTime),
      };

      if (!groupId && text.toLowerCase().startsWith("link ")) {
        await ctx.scheduler.runAfter(0, internal.channels.google_chat.handleLinkCommand, {
          spaceName,
          googleUserId,
          code: text.slice(5).trim(),
          displayName,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.channels.google_chat.handleIncomingMessage, {
          spaceName,
          googleUserId,
          text,
          displayName,
          groupId,
          ...(attachments.length > 0 ? { attachments } : {}),
          channelEnvelope: envelope,
        });
      }
    } else if (eventType.includes("REACTION")) {
      const spaceName = event.space?.name ?? "";
      const spaceType = (event.space?.type ?? "").toLowerCase();
      const groupId = spaceType && spaceType !== "dm" ? spaceName : undefined;
      const googleUserId = normalizeGoogleChatUserId(
        event.reaction?.user?.name ?? event.user?.name,
      );
      const emoji = (event.reaction?.emoji?.unicode ?? "").trim();
      if (!spaceName || !googleUserId || !emoji) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const reactionDedupKey = event.message?.name
        ? `reaction:${eventType}:${spaceName}:${googleUserId}:${event.message.name}`
        : event.eventTime
          ? `reaction:${eventType}:${spaceName}:${googleUserId}:${event.eventTime}`
          : undefined;
      const googleReactionDedupAllowed = await consumeWebhookDedup(
        ctx,
        "google_chat",
        reactionDedupKey,
      );
      if (!googleReactionDedupAllowed) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const action: "add" | "remove" = eventType.includes("REMOVE") ? "remove" : "add";
      const summary = `Google Chat reaction ${action === "add" ? "added" : "removed"}: ${emoji}`;

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "google_chat",
        key: `${googleUserId}:reaction`,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.google_chat.handleIncomingMessage, {
        spaceName,
        googleUserId,
        text: summary,
        groupId,
        channelEnvelope: {
          provider: "google_chat",
          kind: "reaction" as const,
          chatType: spaceType || undefined,
          externalUserId: googleUserId,
          externalChatId: spaceName,
          externalMessageId: event.message?.name,
          threadId: event.message?.thread?.name,
          text: summary,
          reactions: [{ emoji, action, targetMessageId: event.message?.name }],
          sourceTimestamp: parseIsoTimestampMs(event.eventTime),
        },
        respond: false,
      });
    }

    // Return empty response (async processing)
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Microsoft Teams Webhook (Bot Framework)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/teams",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const appId = process.env.TEAMS_APP_ID;
    if (!appId) {
      console.error("[teams] Missing TEAMS_APP_ID");
      return new Response("Server configuration error", { status: 500 });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const isValid = await verifyTeamsToken(authHeader, appId);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let activity: {
      type?: string;
      id?: string;
      replyToId?: string;
      timestamp?: string;
      localTimestamp?: string;
      text?: string;
      from?: { aadObjectId?: string; id?: string; name?: string };
      serviceUrl?: string;
      conversation?: { id?: string; conversationType?: string };
      attachments?: Array<{
        id?: string;
        name?: string;
        contentType?: string;
        contentUrl?: string;
      }>;
      reactionsAdded?: Array<{ type?: string }>;
      reactionsRemoved?: Array<{ type?: string }>;
    };
    try {
      activity = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const activityType = (activity.type ?? "").toLowerCase();
    const teamsUserId = activity.from?.aadObjectId ?? activity.from?.id ?? "";
    const displayName = activity.from?.name;
    const serviceUrl = activity.serviceUrl ?? "";
    const conversationId = activity.conversation?.id ?? "";
    const conversationType = (activity.conversation?.conversationType ?? "").toLowerCase();
    const groupId =
      conversationType === "groupchat" || conversationType === "channel"
        ? conversationId
        : undefined;
    const attachments = extractTeamsAttachments(activity.attachments);
    const cleanedText = (activity.text ?? "").replace(/<at>.*?<\/at>/g, "").trim();
    const sourceTimestamp = parseIsoTimestampMs(activity.localTimestamp ?? activity.timestamp);
    const externalMessageId = activity.id ?? activity.replyToId ?? undefined;

    if (!teamsUserId || !conversationId) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      activityType === "message" ||
      activityType === "messageupdate" ||
      activityType === "messagedelete" ||
      activityType === "messagereaction"
    ) {
      const teamsDedupKey = externalMessageId
        ? `${activityType}:${conversationId}:${externalMessageId}`
        : activity.timestamp
          ? `${activityType}:${conversationId}:${teamsUserId}:${activity.timestamp}`
          : undefined;
      const teamsDedupAllowed = await consumeWebhookDedup(ctx, "teams", teamsDedupKey);
      if (!teamsDedupAllowed) {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      let kind: "message" | "edit" | "delete" | "reaction";
      let respond: boolean;
      let text = "";
      let reactions: Array<{ emoji: string; action: "add" | "remove"; targetMessageId?: string }> =
        [];

      if (activityType === "message") {
        kind = "message";
        respond = true;
        text = summarizeTeamsMessage(cleanedText, attachments);
        if (!text && attachments.length === 0) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
      } else if (activityType === "messageupdate") {
        kind = "edit";
        respond = false;
        text =
          summarizeTeamsMessage(cleanedText, attachments) ||
          `Teams edited message ${externalMessageId ?? "unknown"}`;
      } else if (activityType === "messagedelete") {
        kind = "delete";
        respond = false;
        text = `Teams deleted message ${externalMessageId ?? "unknown"}`;
      } else {
        kind = "reaction";
        respond = false;
        const targetMessageId = activity.replyToId ?? activity.id;
        const added = (activity.reactionsAdded ?? [])
          .map((reaction) => (reaction.type ?? "").trim())
          .filter((emoji): emoji is string => emoji.length > 0)
          .map((emoji) => ({ emoji, action: "add" as const, targetMessageId }));
        const removed = (activity.reactionsRemoved ?? [])
          .map((reaction) => (reaction.type ?? "").trim())
          .filter((emoji): emoji is string => emoji.length > 0)
          .map((emoji) => ({ emoji, action: "remove" as const, targetMessageId }));
        reactions = [...removed, ...added];
        if (reactions.length === 0) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const addedText = added.map((reaction) => reaction.emoji).join(", ") || "none";
        const removedText = removed.map((reaction) => reaction.emoji).join(", ") || "none";
        text = `Teams reaction update on message ${targetMessageId ?? "unknown"}: ${removedText} -> ${addedText}`;
      }

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "teams",
        key: kind === "message" ? teamsUserId : `${teamsUserId}:${kind}`,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      const envelope = {
        provider: "teams",
        kind,
        chatType: conversationType || undefined,
        externalUserId: teamsUserId,
        externalChatId: conversationId,
        externalMessageId,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(reactions.length > 0 ? { reactions } : {}),
        sourceTimestamp,
      };

      if (respond && !groupId && text.toLowerCase().startsWith("link ")) {
        await ctx.scheduler.runAfter(0, internal.channels.teams.handleLinkCommand, {
          serviceUrl,
          conversationIdTeams: conversationId,
          teamsUserId,
          code: text.slice(5).trim(),
          displayName,
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.channels.teams.handleIncomingMessage, {
          serviceUrl,
          conversationIdTeams: conversationId,
          teamsUserId,
          text,
          displayName,
          groupId,
          ...(attachments.length > 0 ? { attachments } : {}),
          channelEnvelope: envelope,
          ...(respond ? {} : { respond: false }),
        });
      }
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Linq Webhook (iMessage/RCS/SMS via Linq Partner API)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/linq",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.LINQ_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("[linq] Missing LINQ_WEBHOOK_SECRET");
      return new Response("Server configuration error", { status: 500 });
    }

    const signature = request.headers.get("x-webhook-signature") ?? "";
    const timestamp = request.headers.get("x-webhook-timestamp") ?? "";
    const rawBody = await request.text();

    const isValid = await verifyLinqSignature(rawBody, signature, timestamp, webhookSecret);
    if (!isValid) {
      return new Response("Unauthorized", { status: 401 });
    }

    let envelope: {
      event_type?: string;
      data?: {
        chat?: { id?: string; is_group?: boolean; owner_handle?: { handle?: string } };
        sender_handle?: { handle?: string };
        message?: { id?: string; created_at?: string; timestamp?: string };
        parts?: Array<{
          id?: string;
          type?: string;
          value?: string;
          url?: string;
          name?: string;
          mime_type?: string;
        }>;
      };
    };
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Only handle incoming messages
    if (envelope.event_type !== "message.received") {
      return new Response("OK", { status: 200 });
    }

    const senderPhone = envelope.data?.sender_handle?.handle ?? "";
    const fromNumber = process.env.LINQ_FROM_NUMBER ?? "";
    const isGroup = envelope.data?.chat?.is_group ?? false;

    // Skip self-messages (our own outgoing messages echoed back)
    if (!senderPhone || senderPhone === fromNumber) {
      return new Response("OK", { status: 200 });
    }

    // Extract text + attachments from message parts
    const parts = envelope.data?.parts ?? [];
    const textOnly = parts
      .filter((p) => p.type === "text")
      .map((p) => p.value ?? "")
      .join("\n")
      .trim();
    const attachments = extractLinqAttachments(parts);
    const text = summarizeLinqMessage(textOnly, attachments);

    if (!text && attachments.length === 0) {
      return new Response("OK", { status: 200 });
    }

    const incomingChatId = envelope.data?.chat?.id ?? "";
    const linqMessageId = envelope.data?.message?.id;
    const linqDedupKey = linqMessageId
      ? `${senderPhone}:${incomingChatId}:${linqMessageId}`
      : undefined;
    const linqDedupAllowed = await consumeWebhookDedup(ctx, "linq", linqDedupKey);
    if (!linqDedupAllowed) {
      return new Response("OK", { status: 200 });
    }

    // Rate limit
    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "linq",
      key: senderPhone,
      limit: 30,
      windowMs: WEBHOOK_RATE_WINDOW_MS,
      blockMs: WEBHOOK_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      console.log("[linq] Rate limited:", senderPhone);
      return rateLimitResponse(rateLimit.retryAfterMs);
    }

    console.log("[linq] Dispatching message from", senderPhone, "text:", text.slice(0, 100), "chatId:", incomingChatId);

    // Detect link code: bare 6-digit alphanumeric code, or "link CODE"
    const linkPrefix = textOnly.toLowerCase().startsWith("link ") ? textOnly.slice(5).trim() : textOnly.trim();
    const isLinkCode = /^[A-Z0-9]{6}$/i.test(linkPrefix);
    const sourceTimestamp = parseIsoTimestampMs(
      envelope.data?.message?.created_at ?? envelope.data?.message?.timestamp,
    );
    const channelEnvelope = {
      provider: "linq",
      kind: "message" as const,
      chatType: isGroup ? "group" : "dm",
      externalUserId: senderPhone,
      externalChatId: incomingChatId || undefined,
      externalMessageId: envelope.data?.message?.id,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      sourceTimestamp,
    };

    if (isLinkCode) {
      await ctx.scheduler.runAfter(0, internal.channels.linq.handleStartCommand, {
        senderPhone,
        text: linkPrefix,
        incomingChatId,
      });
    } else {
      await ctx.scheduler.runAfter(0, internal.channels.linq.handleIncomingMessage, {
        senderPhone,
        text,
        incomingChatId,
        groupId: isGroup ? incomingChatId : undefined,
        ...(attachments.length > 0 ? { attachments } : {}),
        channelEnvelope,
      });
    }

    console.log("[linq] Handler scheduled, returning 200");
    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Bridge Poll Endpoint (bridge.js polls for outbound replies)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/bridge/poll",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    let body: { provider?: string; ownerId?: string };
    try {
      body = JSON.parse(rawBody) as { provider?: string; ownerId?: string };
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!body.ownerId || !body.provider) {
      return new Response("Invalid payload", { status: 400 });
    }

    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: body.ownerId,
      provider: body.provider,
    });
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    const signatureResult = await verifyBridgeSignedRequest(
      request,
      session.webhookSecret,
      rawBody,
    );
    if (signatureResult instanceof Response) {
      return signatureResult;
    }

    const nonceResult = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "bridge_nonce",
      key: `${body.ownerId}:${body.provider}:${signatureResult.nonce}`,
      limit: 1,
      windowMs: BRIDGE_REPLAY_WINDOW_MS,
      blockMs: BRIDGE_REPLAY_WINDOW_MS,
    });
    if (!nonceResult.allowed) {
      return new Response("Unauthorized", { status: 401 });
    }

    const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "bridge",
      key: `${body.ownerId}:${body.provider}:poll`,
      limit: 120,
      windowMs: WEBHOOK_RATE_WINDOW_MS,
      blockMs: WEBHOOK_RATE_WINDOW_MS,
    });
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAfterMs);
    }

    const messages = await ctx.runMutation(internal.channels.bridge_outbound.claim, {
      sessionId: session._id,
    });

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Bridge Webhook (WhatsApp, Signal ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â persistent processes in Sprites)
// ---------------------------------------------------------------------------

http.route({
  path: "/api/webhooks/bridge",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    let payload: {
      type: string;
      provider?: string;
      ownerId?: string;
      externalUserId?: string;
      text?: string;
      displayName?: string;
      groupId?: string;
      chatType?: string;
      kind?: string;
      externalMessageId?: string;
      threadId?: string;
      attachments?: unknown;
      reactions?: unknown;
      sourceTimestamp?: number;
      respond?: boolean;
      replyCallback?: string;
      authState?: unknown;
      status?: string;
      error?: string;
    };
    try {
      payload = JSON.parse(rawBody) as {
        type: string;
        provider?: string;
        ownerId?: string;
        externalUserId?: string;
        text?: string;
        displayName?: string;
        groupId?: string;
        chatType?: string;
        kind?: string;
        externalMessageId?: string;
        threadId?: string;
        attachments?: unknown;
        reactions?: unknown;
        sourceTimestamp?: number;
        respond?: boolean;
        replyCallback?: string;
        authState?: unknown;
        status?: string;
        error?: string;
      };
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!payload.ownerId || !payload.provider) {
      return new Response("Invalid payload", { status: 400 });
    }

    const session = await ctx.runQuery(internal.channels.bridge.getBridgeSession, {
      ownerId: payload.ownerId,
      provider: payload.provider,
    });
    if (!session) {
      return new Response("Unauthorized", { status: 401 });
    }

    const signatureResult = await verifyBridgeSignedRequest(
      request,
      session.webhookSecret,
      rawBody,
    );
    if (signatureResult instanceof Response) {
      return signatureResult;
    }

    const nonceResult = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
      scope: "bridge_nonce",
      key: `${payload.ownerId}:${payload.provider}:${signatureResult.nonce}`,
      limit: 1,
      windowMs: BRIDGE_REPLAY_WINDOW_MS,
      blockMs: BRIDGE_REPLAY_WINDOW_MS,
    });
    if (!nonceResult.allowed) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (payload.type === "heartbeat") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:heartbeat`,
        limit: 120,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleHeartbeat, {
        ownerId: payload.ownerId,
        provider: payload.provider,
      });
    } else if (payload.type === "auth_update") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:auth`,
        limit: 30,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleAuthUpdate, {
        ownerId: payload.ownerId,
        provider: payload.provider,
        authState: payload.authState ?? {},
        status: payload.status ?? "awaiting_auth",
      });
    } else if (payload.type === "message") {
      const kind = isChannelEventKind(payload.kind) ? payload.kind : "message";
      const attachments = extractBridgeAttachments(payload.attachments);
      const reactions = normalizeBridgeReactions(payload.reactions);
      const text = (payload.text ?? "").trim();
      const fallbackText =
        kind !== "message"
          ? `${payload.provider} ${kind} update`
          : summarizeLinqMessage("", attachments);
      const effectiveText = text || fallbackText;

      if (!payload.externalUserId || !effectiveText) {
        return new Response("OK", { status: 200 });
      }
      const bridgeDedupAllowed = await consumeWebhookDedup(
        ctx,
        "bridge",
        payload.externalMessageId
          ? `${payload.ownerId}:${payload.provider}:${payload.externalUserId}:${kind}:${payload.externalMessageId}`
          : undefined,
      );
      if (!bridgeDedupAllowed) {
        return new Response("OK", { status: 200 });
      }

      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key:
          kind === "message"
            ? `${payload.ownerId}:${payload.provider}:${payload.externalUserId}`
            : `${payload.ownerId}:${payload.provider}:${payload.externalUserId}:${kind}`,
        limit: 40,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      const channelEnvelope = {
        provider: payload.provider,
        kind,
        chatType: payload.chatType,
        externalUserId: payload.externalUserId,
        externalChatId: payload.groupId,
        externalMessageId: payload.externalMessageId,
        threadId: payload.threadId,
        text: effectiveText,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(reactions.length > 0 ? { reactions } : {}),
        sourceTimestamp: payload.sourceTimestamp,
      };

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleBridgeMessage, {
        provider: payload.provider,
        ownerId: payload.ownerId,
        externalUserId: payload.externalUserId,
        text: effectiveText,
        displayName: payload.displayName,
        groupId: payload.groupId,
        ...(attachments.length > 0 ? { attachments } : {}),
        channelEnvelope,
        respond: payload.respond,
      });
    } else if (payload.type === "error") {
      const rateLimit = await ctx.runMutation(internal.channels.utils.consumeWebhookRateLimit, {
        scope: "bridge",
        key: `${payload.ownerId}:${payload.provider}:error`,
        limit: 20,
        windowMs: WEBHOOK_RATE_WINDOW_MS,
        blockMs: WEBHOOK_RATE_WINDOW_MS,
      });
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterMs);
      }

      await ctx.scheduler.runAfter(0, internal.channels.bridge.handleBridgeError, {
        ownerId: payload.ownerId,
        provider: payload.provider,
        error: payload.error ?? "Unknown error",
      });
    }

    return new Response("OK", { status: 200 });
  }),
});

// ---------------------------------------------------------------------------
// Stella AI Proxy — thin LLM/embed/search proxy for desktop local runtime
// ---------------------------------------------------------------------------

import { proxyChat, proxyEmbed, proxySearch, llmProxy } from "./ai_proxy";

const proxyOptionsHandler = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("origin");
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
});

http.route({ path: "/api/ai/proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/proxy", method: "POST", handler: proxyChat });

http.route({ path: "/api/ai/embed", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/embed", method: "POST", handler: proxyEmbed });

http.route({ path: "/api/ai/search", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/search", method: "POST", handler: proxySearch });

// Transparent LLM reverse proxy for local agent runtime
http.route({ path: "/api/ai/llm-proxy", method: "OPTIONS", handler: proxyOptionsHandler });
http.route({ path: "/api/ai/llm-proxy", method: "POST", handler: llmProxy });

export default http;


