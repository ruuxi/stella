/**
 * Connector Delivery: Handles async delivery of responses back to connectors
 * when using inverted execution (local device runs the AI turn).
 *
 * Flow:
 * 1. Local device finishes a remote turn request
 * 2. Local device calls `completeRemoteTurn` (public mutation)
 * 3. Mutation inserts a fulfilled marker and schedules `deliverToConnector`
 * 4. `deliverToConnector` sends the response to the appropriate connector
 */
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import { jsonValueValidator } from "../shared_validators";
import { retryFetch } from "../lib/retry_fetch";
import { requireConversationOwner } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
} from "../lib/rate_limits";
import { runAgentTurn } from "../automation/runner";
import type { Id } from "../_generated/dataModel";
import {
  SLACK_MAX_MESSAGE_CHARS,
  TELEGRAM_MAX_MESSAGE_CHARS,
  DISCORD_MAX_MESSAGE_CHARS,
  GOOGLE_CHAT_MAX_MESSAGE_CHARS,
  TEAMS_MAX_MESSAGE_CHARS,
  truncateForConnector,
} from "./connector_constants";
import { getGoogleAccessToken, getTeamsBotToken } from "./connector_auth";
import {
  EXECUTION_NOT_AVAILABLE_MESSAGE,
  shouldUseOfflineResponderForProvider,
} from "./execution_policy";

const BACKEND_FALLBACK_AGENT_TYPE = "offline_responder";
const EMPTY_RESPONSE_TEXT = "(Stella had nothing to say.)";

/**
 * Look up the original `remote_turn_request` event by `requestId`. The
 * lifecycle (`pending` / `claimed` / `fulfilled`) lives directly on this
 * row — there are no longer any separate `remote_turn_claimed` /
 * `remote_turn_fulfilled` event rows to chase.
 */
const findRemoteTurnRequest = async (
  ctx: QueryCtx | MutationCtx,
  requestId: string,
) =>
  await ctx.db
    .query("events")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .first();

// ─── Public Mutation (called by local device via HTTP) ──────────────────────
export const claimRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(ctx, args.conversationId);
    await enforceMutationRateLimit(
      ctx,
      "connector_claim_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    if (request.requestState === "claimed" || request.requestState === "fulfilled") {
      return null;
    }

    await ctx.db.patch(request._id, {
      requestState: "claimed",
      claimedAt: Date.now(),
      ...(args.deviceId ? { claimedByDeviceId: args.deviceId } : {}),
    });

    return null;
  },
});

export const completeRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
    deviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await requireConversationOwner(ctx, args.conversationId);
    await enforceMutationRateLimit(
      ctx,
      "connector_complete_remote_turn",
      conversation.ownerId,
      RATE_HOT_PATH,
    );

    // Read routing metadata from the original remote_turn_request event
    // (never trust caller-provided routing data)
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Invalid or missing remote_turn_request",
      });
    }
    if (request.requestState === "fulfilled") return null;

    const reqPayload = request.payload as Record<string, unknown>;
    const provider = reqPayload.provider as string;
    const deliveryMeta = reqPayload.deliveryMeta as Record<string, unknown>;

    // Mark as claimed so subsequent reads see consistent state. The
    // delivery action will flip it to `fulfilled` after the connector POST
    // succeeds.
    if (request.requestState !== "claimed") {
      await ctx.db.patch(request._id, {
        requestState: "claimed",
        claimedAt: Date.now(),
        ...(args.deviceId ? { claimedByDeviceId: args.deviceId } : {}),
      });
    }

    // Schedule async delivery — fulfilled marker is set by
    // deliverToConnector AFTER successful delivery
    await ctx.scheduler.runAfter(
      0,
      internal.channels.connector_delivery.deliverToConnector,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        provider,
        deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta ?? {})),
        text: args.text,
      },
    );

    return null;
  },
});

// ─── Shared delivery logic (callable from any action in the same runtime) ───

type DeliveryCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

type DeliveryArgs = {
  requestId: string;
  conversationId: Id<"conversations">;
  provider: string;
  deliveryMeta: Record<string, unknown>;
  text: string;
};

async function deliverToConnectorCore(
  ctx: DeliveryCtx,
  args: DeliveryArgs,
): Promise<void> {
  const meta = args.deliveryMeta;

  try {
    switch (args.provider) {
      case "slack":
        await deliverSlack(ctx, meta, args.text);
        break;
      case "telegram":
        await deliverTelegram(meta, args.text);
        break;
      case "discord":
        await deliverDiscord(meta, args.text);
        break;
      case "google_chat":
        await deliverGoogleChat(meta, args.text);
        break;
      case "teams":
        await deliverTeams(meta, args.text);
        break;
      case "linq":
        await deliverLinq(meta, args.text);
        break;
      case "stella_app":
        break;
      default:
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: `Unknown delivery provider: ${args.provider}`,
        });
    }

    // Mark fulfilled AFTER successful delivery — patches the original
    // `remote_turn_request` row in place.
    await ctx.runMutation(
      internal.channels.connector_delivery.markRemoteTurnFulfilled,
      { requestId: args.requestId },
    );
  } catch (error) {
    // NOT marking fulfilled — watchdog will retry delivery
    console.error(
      `[connector_delivery] Delivery failed for ${args.provider}:`,
      error,
    );
  }
}

// ─── Shared: run backend fallback agent + deliver to connector ──────────────

async function runFallbackAndDeliver(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    ownerId: string;
    prompt: string;
    provider: string;
    deliveryMeta: Record<string, unknown>;
    userMessageId?: string;
  },
): Promise<void> {
  const result = await runAgentTurn({
    ctx,
    conversationId: args.conversationId,
    prompt: args.prompt,
    agentType: BACKEND_FALLBACK_AGENT_TYPE,
    ownerId: args.ownerId,
    userMessageId: args.userMessageId as Id<"events"> | undefined,
  });

  if (result.text.trim() && !result.silent) {
    await persistConnectorAssistantMessage(ctx, {
      conversationId: args.conversationId,
      provider: args.provider,
      text: result.text,
      usage: result.usage,
    });
  }

  const responseText = result.text.trim() || EMPTY_RESPONSE_TEXT;
  await deliverToConnectorCore(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    provider: args.provider,
    deliveryMeta: args.deliveryMeta,
    text: responseText,
  });
}

async function persistConnectorAssistantMessage(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    conversationId: Id<"conversations">;
    provider: string;
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  },
): Promise<void> {
  await ctx.runMutation(internal.events.appendInternalEvent, {
    conversationId: args.conversationId,
    type: "assistant_message",
    payload: {
      text: args.text,
      source: `channel:${args.provider}`,
      ...(args.usage ? { usage: args.usage } : {}),
    },
  });
}

async function deliverExecutionUnavailable(
  ctx: ActionCtx,
  args: {
    requestId: string;
    conversationId: Id<"conversations">;
    provider: string;
    deliveryMeta: Record<string, unknown>;
  },
): Promise<void> {
  await persistConnectorAssistantMessage(ctx, {
    conversationId: args.conversationId,
    provider: args.provider,
    text: EXECUTION_NOT_AVAILABLE_MESSAGE,
  });

  await deliverToConnectorCore(ctx, {
    requestId: args.requestId,
    conversationId: args.conversationId,
    provider: args.provider,
    deliveryMeta: args.deliveryMeta,
    text: EXECUTION_NOT_AVAILABLE_MESSAGE,
  });
}

async function isTargetDeviceStillFresh(
  ctx: ActionCtx,
  args: {
    ownerId: string;
    targetDeviceId?: string;
  },
): Promise<boolean> {
  if (!args.targetDeviceId) {
    return false;
  }

  const freshDevices = await ctx.runQuery(
    internal.agent.device_resolver.listFreshDevicesForOwner,
    { ownerId: args.ownerId, nowMs: Date.now() },
  ) as Array<{ deviceId: string }>;
  return freshDevices.some((device) => device.deviceId === args.targetDeviceId);
}

// ─── Per-request fallback (scheduled by message_pipeline) ───────────────────
// Runs a few seconds after a remote_turn_request is inserted. This fast rescue
// exists only for the mobile app's backend offline responder. Other connectors
// must wait for the normal desktop flow or the slower orphan watchdog; an
// unclaimed request after a few seconds does not mean the desktop is offline.
export const rescueSingleTurn = internalAction({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if desktop already claimed or fulfilled this request — both
    // states live on the original `remote_turn_request` row now, so a
    // single read is enough.
    const requestState = (await ctx.runQuery(
      internal.channels.connector_delivery.getRemoteTurnState,
      { requestId: args.requestId },
    )) as "pending" | "claimed" | "fulfilled" | null;

    console.log(
      `[rescue:trace] requestId=${args.requestId}, state=${requestState ?? "missing"}`,
    );
    if (requestState === "claimed" || requestState === "fulfilled") return null;

    if (!shouldUseOfflineResponderForProvider(args.provider)) {
      console.log(
        `[rescue:trace] Skipping fast rescue for provider=${args.provider}; waiting for desktop claim or orphan watchdog.`,
      );
      return null;
    }

    if (await isTargetDeviceStillFresh(ctx, {
      ownerId: args.ownerId,
      targetDeviceId: args.targetDeviceId,
    })) {
      console.log(
        `[rescue:trace] Skipping fast rescue for ${args.requestId}; target desktop is still online.`,
      );
      return null;
    }

    console.log(
      `[rescue:trace] Desktop did not claim ${args.requestId}, running offline responder`,
    );

    await runFallbackAndDeliver(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      prompt: args.prompt,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta as Record<string, unknown>,
      userMessageId: args.userMessageId,
    });

    return null;
  },
});

// ─── Internal Action (delivers message to connector) ────────────────────────
export const deliverToConnector = internalAction({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await deliverToConnectorCore(ctx, {
      requestId: args.requestId,
      conversationId: args.conversationId,
      provider: args.provider,
      deliveryMeta: args.deliveryMeta as Record<string, unknown>,
      text: args.text,
    });
    return null;
  },
});

async function deliverSlack(
  ctx: Pick<ActionCtx, "runQuery">,
  meta: Record<string, unknown>,
  text: string,
) {
  const channelId = meta.channelId as string;
  const teamId = meta.teamId as string | undefined;
  if (!channelId) {
    console.error("[connector_delivery] Slack delivery missing channelId");
    return;
  }

  // Resolve bot token (per-workspace installation or global fallback)
  let token: string | null = null;
  if (teamId) {
    const installation = (await ctx.runQuery(
      internal.channels.slack_installations.getByTeamId,
      { teamId },
    )) as { botToken: string } | null;
    if (installation) token = installation.botToken;
  }
  if (!token) {
    token = process.env.SLACK_BOT_TOKEN ?? null;
  }
  if (!token) {
    console.error("[connector_delivery] No Slack bot token available");
    return;
  }

  const truncated = truncateForConnector(text, SLACK_MAX_MESSAGE_CHARS);

  const res = await retryFetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text: truncated }),
  });

  if (!res.ok) {
    console.error(
      "[connector_delivery] Slack send failed:",
      res.status,
      await res.text(),
    );
  }
}
async function deliverTelegram(
  meta: Record<string, unknown>,
  text: string,
) {
  const chatId = meta.chatId as string;
  if (!chatId) {
    console.error("[connector_delivery] Telegram delivery missing chatId");
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[connector_delivery] Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  const truncated = truncateForConnector(text, TELEGRAM_MAX_MESSAGE_CHARS);

  // Try MarkdownV2 first, fall back to plain text
  const mdRes = await retryFetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncated,
        parse_mode: "MarkdownV2",
      }),
    },
  );

  if (!mdRes.ok) {
    await retryFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncated }),
    });
  }
}
async function deliverDiscord(
  meta: Record<string, unknown>,
  text: string,
) {
  const applicationId = meta.applicationId as string;
  const interactionToken = meta.interactionToken as string;
  if (!applicationId || !interactionToken) {
    console.error(
      "[connector_delivery] Discord delivery missing applicationId or interactionToken",
    );
    return;
  }

  const truncated = truncateForConnector(text, DISCORD_MAX_MESSAGE_CHARS);

  // Edit the deferred interaction response
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncated }),
    },
  );

  if (!res.ok) {
    // Interaction token may have expired (15-minute limit).
    // Try sending as a follow-up message instead.
    const followUpRes = await fetch(
      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: truncated }),
      },
    );
    if (!followUpRes.ok) {
      console.error(
        "[connector_delivery] Discord delivery failed (both edit and follow-up):",
        res.status,
        followUpRes.status,
      );
    }
  }
}
async function deliverGoogleChat(
  meta: Record<string, unknown>,
  text: string,
) {
  const spaceName = meta.spaceName as string;
  if (!spaceName) {
    console.error(
      "[connector_delivery] Google Chat delivery missing spaceName",
    );
    return;
  }

  const accessToken = await getGoogleAccessToken();

  const truncated = truncateForConnector(text, GOOGLE_CHAT_MAX_MESSAGE_CHARS);

  const res = await retryFetch(
    `https://chat.googleapis.com/v1/${spaceName}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: truncated }),
    },
  );

  if (!res.ok) {
    console.error(
      "[connector_delivery] Google Chat send failed:",
      res.status,
      await res.text(),
    );
  }
}
async function deliverTeams(meta: Record<string, unknown>, text: string) {
  const serviceUrl = meta.serviceUrl as string;
  const conversationId = meta.conversationIdTeams as string;
  if (!serviceUrl || !conversationId) {
    console.error(
      "[connector_delivery] Teams delivery missing serviceUrl or conversationIdTeams",
    );
    return;
  }

  const token = await getTeamsBotToken();

  const truncated = truncateForConnector(text, TEAMS_MAX_MESSAGE_CHARS);

  const baseUrl = serviceUrl.endsWith("/")
    ? serviceUrl.slice(0, -1)
    : serviceUrl;

  const res = await retryFetch(
    `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "message", text: truncated }),
    },
  );

  if (!res.ok) {
    console.error(
      "[connector_delivery] Teams send failed:",
      res.status,
      await res.text(),
    );
  }
}
async function deliverLinq(meta: Record<string, unknown>, text: string) {
  const incomingChatId = meta.incomingChatId as string | undefined;
  const senderPhone = meta.senderPhone as string;
  if (!senderPhone) {
    console.error(
      "[connector_delivery] Linq delivery missing senderPhone",
    );
    return;
  }

  const apiToken = process.env.LINQ_API_TOKEN;
  const fromNumber = process.env.LINQ_FROM_NUMBER;
  if (!apiToken || !fromNumber) {
    console.error(
      "[connector_delivery] Missing LINQ_API_TOKEN or LINQ_FROM_NUMBER",
    );
    return;
  }

  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };

  // Try incoming chat ID first
  if (incomingChatId) {
    const res = await retryFetch(
      `https://api.linqapp.com/api/partner/v3/chats/${incomingChatId}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: { parts: [{ type: "text", value: text }] },
        }),
      },
    );
    if (res.ok) return;
    console.error(
      "[connector_delivery] Linq incomingChatId send failed, trying new chat",
    );
  }

  // Create new chat
  const res = await retryFetch(
    "https://api.linqapp.com/api/partner/v3/chats",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: fromNumber,
        to: [senderPhone],
        message: { parts: [{ type: "text", value: text }] },
      }),
    },
  );

  if (!res.ok) {
    console.error(
      "[connector_delivery] Linq createChat failed:",
      res.status,
      await res.text(),
    );
  }
}
/** Fetch the most recent assistant_message text for a conversation. */
async function getLatestAssistantText(
  ctx: Pick<ActionCtx, "runQuery">,
  conversationId: Id<"conversations">,
): Promise<string> {
  const events = (await ctx.runQuery(
    internal.events.listEventsSince,
    {
      conversationId,
      limit: 20,
    },
  )) as Array<{ type: string; payload: Record<string, unknown> }> | null;

  if (!events) return EMPTY_RESPONSE_TEXT;

  // listEventsSince returns asc order — walk backwards to find the latest
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "assistant_message") {
      return (events[i].payload?.text as string) ?? EMPTY_RESPONSE_TEXT;
    }
  }
  return EMPTY_RESPONSE_TEXT;
}

const RESCUE_DELAY_MS = 5_000;

export const scheduleRescue = internalMutation({
  args: {
    requestId: v.string(),
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    prompt: v.string(),
    provider: v.string(),
    deliveryMeta: jsonValueValidator,
    userMessageId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      RESCUE_DELAY_MS,
      internal.channels.connector_delivery.rescueSingleTurn,
      {
        requestId: args.requestId,
        conversationId: args.conversationId,
        ownerId: args.ownerId,
        prompt: args.prompt,
        provider: args.provider,
        deliveryMeta: args.deliveryMeta,
        userMessageId: args.userMessageId,
        targetDeviceId: args.targetDeviceId,
      },
    );
  },
});

/**
 * Returns the lifecycle state of a remote turn — `null` if the request
 * itself doesn't exist. Replaces the previous pair of `findClaimedEvent` /
 * `getRemoteTurnFulfilled` lookups, each of which hit the `by_requestId`
 * index separately.
 */
export const getRemoteTurnState = internalQuery({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.literal("pending"),
    v.literal("claimed"),
    v.literal("fulfilled"),
  ),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    return request.requestState ?? "pending";
  },
});

/**
 * Patch a `remote_turn_request` row to `fulfilled` after successful
 * delivery. Idempotent: a second call is a no-op.
 */
export const markRemoteTurnFulfilled = internalMutation({
  args: { requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await findRemoteTurnRequest(ctx, args.requestId);
    if (!request || request.type !== "remote_turn_request") return null;
    if (request.requestState === "fulfilled") return null;
    await ctx.db.patch(request._id, {
      requestState: "fulfilled",
      fulfilledAt: Date.now(),
    });
    return null;
  },
});

const ORPHAN_MIN_AGE_MS = 90_000; // must be at least 90s old
const ORPHAN_MAX_AGE_MS = 10 * 60_000; // ignore anything older than 10 min

export const findOrphanedTurnRequests = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args) => {
    const now = args.nowMs;

    // Check all registered devices — routing always tries the desktop
    // first and relies on this watchdog for fallback, so we cannot
    // limit the scan to offline devices only.
    const allDevices = await ctx.db
      .query("devices")
      .take(200);

    if (allDevices.length === 0) return [];

    type OrphanResult = {
      eventId: Id<"events">;
      requestId: string;
      conversationId: Id<"conversations">;
      targetDeviceId: string;
      payload: Record<string, string | undefined>;
      claimed: boolean;
    };

    const devicePromises = allDevices.map(async (device) => {
      const orphansForDevice: OrphanResult[] = [];
      const events = await ctx.db
        .query("events")
        .withIndex("by_targetDeviceId_and_timestamp", (q) =>
          q
            .eq("targetDeviceId", device.deviceId)
            .gte("timestamp", now - ORPHAN_MAX_AGE_MS)
            .lte("timestamp", now - ORPHAN_MIN_AGE_MS),
        )
        .take(20);

      // Lifecycle state lives on the request row itself, so we can decide
      // every event from the rows we already have — no per-event extra
      // index lookups.
      for (const event of events) {
        if (event.type !== "remote_turn_request") continue;
        if (!event.requestId) continue;
        if (event.requestState === "fulfilled") continue;

        const p = event.payload as Record<string, unknown>;
        orphansForDevice.push({
          eventId: event._id,
          requestId: event.requestId,
          conversationId: event.conversationId,
          targetDeviceId: event.targetDeviceId!,
          payload: JSON.parse(JSON.stringify(p)),
          claimed: event.requestState === "claimed",
        });
      }
      return orphansForDevice;
    });

    const results = await Promise.all(devicePromises);
    const orphans = results.flat();

    return orphans;
  },
});

export const rescueOrphanedTurns = internalAction({
  args: {},
  handler: async (ctx) => {
    const orphans = await ctx.runQuery(
      internal.channels.connector_delivery.findOrphanedTurnRequests,
      { nowMs: Date.now() },
    );

    if (orphans.length === 0) return null;

    console.log(
      `[watchdog] Found ${orphans.length} orphaned remote turn request(s)`,
    );

    for (const orphan of orphans) {
      const payload = orphan.payload as Record<string, unknown>;
      const source = (payload.source as string | undefined) ?? "connector";
      const isCronRequest = source === "cron";
      const conversationId = orphan.conversationId;
      const userMessageId = payload.userMessageId as string | undefined;
      const prompt = (payload.text as string) ?? "";
      const provider = (payload.provider as string) ?? "";
      const deliveryMeta =
        (payload.deliveryMeta as Record<string, unknown>) ?? {};

      try {
        if (isCronRequest) {
          if (orphan.claimed) {
            // Claimed cron turns should be fulfilled atomically by desktop.
            // If they are still orphaned, mark as failed to unblock the job.
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error:
                  "Cron turn was claimed by desktop but never fulfilled before watchdog timeout.",
                skipAssistantMessage: true,
              },
            );
            console.log(
              `[watchdog] Rescued cron orphan ${orphan.requestId} (claimed -> marked failed)`,
            );
            continue;
          }

          const conversation = await ctx.runQuery(internal.conversations.getById, {
            id: conversationId,
          });
          if (!conversation) {
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error: `Conversation ${String(conversationId)} not found during watchdog rescue.`,
                skipAssistantMessage: true,
              },
            );
            continue;
          }

          const result = await runAgentTurn({
            ctx,
            conversationId,
            prompt,
            agentType: BACKEND_FALLBACK_AGENT_TYPE,
            ownerId: conversation.ownerId,
            userMessageId: userMessageId as Id<"events"> | undefined,
          });

          await ctx.runMutation(
            internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
            {
              requestId: orphan.requestId,
              conversationId,
              text: result.text.trim(),
              status: "ok",
            },
          );
          console.log(
            `[watchdog] Rescued cron orphan ${orphan.requestId} (backend fallback execution)`,
          );
          continue;
        }

        if (orphan.claimed) {
          // Case 1: Claimed but not fulfilled — the local device ran the turn
          // but delivery failed. Retry delivery only (no re-execution).
          console.log(
            `[watchdog] Retrying delivery for claimed turn ${orphan.requestId}`,
          );
          await deliverToConnectorCore(ctx, {
            requestId: orphan.requestId,
            conversationId: orphan.conversationId,
            provider,
            deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta)),
            text: await getLatestAssistantText(ctx, orphan.conversationId),
          });
        } else {
          // Case 2: Not claimed — device went offline before picking up the
          // request. Non-mobile connectors should never use the offline
          // responder; return the execution-unavailable message instead.
          if (!shouldUseOfflineResponderForProvider(provider)) {
            await deliverExecutionUnavailable(ctx, {
              requestId: orphan.requestId,
              conversationId,
              provider,
              deliveryMeta,
            });
            console.log(
              `[watchdog] Rescued orphan ${orphan.requestId} (execution unavailable) → ${provider}`,
            );
            continue;
          }

          // Mobile app can still use the backend offline responder.
          const conversation = await ctx.runQuery(
            internal.conversations.getById,
            { id: conversationId },
          );
          if (!conversation) {
            console.error(
              `[watchdog] Conversation ${String(conversationId)} not found, skipping`,
            );
            continue;
          }

          if (await isTargetDeviceStillFresh(ctx, {
            ownerId: conversation.ownerId,
            targetDeviceId: orphan.targetDeviceId,
          })) {
            console.log(
              `[watchdog] Skipping mobile fallback for ${orphan.requestId}; target desktop is still online.`,
            );
            continue;
          }

          await runFallbackAndDeliver(ctx, {
            requestId: orphan.requestId,
            conversationId,
            ownerId: conversation.ownerId,
            prompt,
            provider,
            deliveryMeta,
            userMessageId,
          });
        }

        console.log(
          `[watchdog] Rescued orphan ${orphan.requestId} (${orphan.claimed ? "delivery retry" : "full rescue"}) → ${provider}`,
        );
      } catch (error) {
        console.error(
          `[watchdog] Failed to rescue orphan ${orphan.requestId}:`,
          error,
        );

        if (isCronRequest) {
          try {
            await ctx.runMutation(
              internal.scheduling.cron_jobs.completeCronTurnResultFromWatchdog,
              {
                requestId: orphan.requestId,
                conversationId,
                text: "",
                status: "error",
                error: String(error),
                skipAssistantMessage: true,
              },
            );
          } catch {
            // Best effort.
          }
          continue;
        }

        // Mark as fulfilled to prevent infinite retries
        try {
          await ctx.runMutation(
            internal.channels.connector_delivery.markRemoteTurnFulfilled,
            { requestId: orphan.requestId },
          );
        } catch {
          // Best effort — if this fails too, the orphan will age out after 10 min
        }
      }
    }

    return null;
  },
});
