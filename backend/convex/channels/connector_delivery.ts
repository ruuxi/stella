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
import { internalAction, internalQuery, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v, ConvexError } from "convex/values";
import { jsonValueValidator } from "../shared_validators";
import { retryFetch } from "../lib/retry_fetch";
import { requireConversationOwner } from "../auth";
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

const BACKEND_FALLBACK_AGENT_TYPE = "offline_responder";

// ─── Public Mutation (called by local device via HTTP) ──────────────────────
export const completeRemoteTurn = mutation({
  args: {
    requestId: v.string(),
    text: v.string(),
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);

    // Idempotency: skip if already claimed
    const existing = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) =>
        q.eq("requestId", `claimed:${args.requestId}`),
      )
      .first();
    if (existing) return null;

    // Read routing metadata from the original remote_turn_request event
    // (never trust caller-provided routing data)
    const request = await ctx.db
      .query("events")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .first();
    if (!request || request.type !== "remote_turn_request") {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "Invalid or missing remote_turn_request" });
    }
    const reqPayload = request.payload as Record<string, unknown>;
    const provider = reqPayload.provider as string;
    const deliveryMeta = reqPayload.deliveryMeta as Record<string, unknown>;

    // Insert claimed marker (for local device dedup)
    await ctx.db.insert("events", {
      conversationId: args.conversationId,
      timestamp: Date.now(),
      type: "remote_turn_claimed",
      requestId: `claimed:${args.requestId}`,
      payload: { requestId: args.requestId },
    });

    // Schedule async delivery — fulfilled marker is inserted by
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
    const meta = args.deliveryMeta as Record<string, unknown>;

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
        default:
          throw new ConvexError({
            code: "INVALID_ARGUMENT",
            message: `Unknown delivery provider: ${args.provider}`,
          });
      }

      // Mark fulfilled AFTER successful delivery
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "remote_turn_fulfilled",
        requestId: `fulfilled:${args.requestId}`,
        payload: { requestId: args.requestId },
      });
    } catch (error) {
      // NOT marking fulfilled — watchdog will retry delivery
      console.error(
        `[connector_delivery] Delivery failed for ${args.provider}:`,
        error,
      );
    }

    return null;
  },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Convex ActionCtx.runQuery/runMutation have complex generated types
type InternalRunCtx = {
  runQuery: (...args: any[]) => Promise<unknown>;
  runMutation: (...args: any[]) => Promise<unknown>;
};

async function deliverSlack(
  ctx: Pick<InternalRunCtx, "runQuery">,
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
  ctx: Pick<InternalRunCtx, "runQuery">,
  conversationId: Id<"conversations">,
): Promise<string> {
  const events = (await ctx.runQuery(
    internal.events.listEventsSince,
    {
      conversationId,
      limit: 20,
    },
  )) as Array<{ type: string; payload: Record<string, unknown> }> | null;

  if (!events) return "(Stella had nothing to say.)";

  // listEventsSince returns asc order — walk backwards to find the latest
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "assistant_message") {
      return (events[i].payload?.text as string) ?? "(Stella had nothing to say.)";
    }
  }
  return "(Stella had nothing to say.)";
}

const ORPHAN_MIN_AGE_MS = 90_000; // must be at least 90s old
const ORPHAN_MAX_AGE_MS = 10 * 60_000; // ignore anything older than 10 min

export const findOrphanedTurnRequests = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Find devices that recently went offline (within the orphan window).
    const offlineDevices = await ctx.db
      .query("devices")
      .withIndex("by_online_and_lastSignedAtMs", (q) =>
        q.eq("online", false).gte("lastSignedAtMs", now - ORPHAN_MAX_AGE_MS),
      )
      .take(200);

    if (offlineDevices.length === 0) return [];

    type OrphanResult = {
      eventId: Id<"events">;
      requestId: string;
      conversationId: Id<"conversations">;
      targetDeviceId: string;
      payload: Record<string, string | undefined>;
      claimed: boolean;
    };
    const orphans: OrphanResult[] = [];

    for (const device of offlineDevices) {
      const events = await ctx.db
        .query("events")
        .withIndex("by_targetDeviceId_and_timestamp", (q) =>
          q
            .eq("targetDeviceId", device.deviceId)
            .gte("timestamp", now - ORPHAN_MAX_AGE_MS)
            .lte("timestamp", now - ORPHAN_MIN_AGE_MS),
        )
        .take(20);

      for (const event of events) {
        if (event.type !== "remote_turn_request") continue;
        if (!event.requestId) continue;

        // Check for fulfilled marker
        const fulfilled = await ctx.db
          .query("events")
          .withIndex("by_requestId", (q) =>
            q.eq("requestId", `fulfilled:${event.requestId}`),
          )
          .first();
        if (fulfilled) continue;

        // Check for claimed marker (local device started but delivery may have failed)
        const claimed = await ctx.db
          .query("events")
          .withIndex("by_requestId", (q) =>
            q.eq("requestId", `claimed:${event.requestId}`),
          )
          .first();

        const p = event.payload as Record<string, unknown>;
        orphans.push({
          eventId: event._id,
          requestId: event.requestId,
          conversationId: event.conversationId,
          targetDeviceId: event.targetDeviceId!,
          payload: JSON.parse(JSON.stringify(p)),
          claimed: claimed !== null,
        });
      }
    }

    return orphans;
  },
});

export const rescueOrphanedTurns = internalAction({
  args: {},
  handler: async (ctx) => {
    const orphans = await ctx.runQuery(
      internal.channels.connector_delivery.findOrphanedTurnRequests,
      {},
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
          await ctx.runAction(
            internal.channels.connector_delivery.deliverToConnector,
            {
              requestId: orphan.requestId,
              conversationId: orphan.conversationId,
              provider,
              deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta)),
              text: await getLatestAssistantText(ctx, orphan.conversationId),
            },
          );
        } else {
          // Case 2: Not claimed — device went offline before picking up the
          // request. Run the full turn through backend fallback + deliver.
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

          const result = await runAgentTurn({
            ctx,
            conversationId,
            prompt,
            agentType: BACKEND_FALLBACK_AGENT_TYPE,
            ownerId: conversation.ownerId,
            userMessageId: userMessageId as Id<"events"> | undefined,
          });

          // Persist assistant message
          if (result.text.trim() && !result.silent) {
            await ctx.runMutation(internal.events.appendInternalEvent, {
              conversationId,
              type: "assistant_message",
              payload: {
                text: result.text,
                source: `channel:${provider}`,
                ...(result.usage ? { usage: result.usage } : {}),
              },
            });
          }

          const responseText =
            result.text.trim() || "(Stella had nothing to say.)";
          await ctx.runAction(
            internal.channels.connector_delivery.deliverToConnector,
            {
              requestId: orphan.requestId,
              conversationId,
              provider,
              deliveryMeta: JSON.parse(JSON.stringify(deliveryMeta)),
              text: responseText,
            },
          );
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
          await ctx.runMutation(internal.events.appendInternalEvent, {
            conversationId,
            type: "remote_turn_fulfilled",
            requestId: `fulfilled:${orphan.requestId}`,
            payload: {
              requestId: orphan.requestId,
              rescuedByWatchdog: true,
              error: String(error),
            },
          });
        } catch {
          // Best effort — if this fails too, the orphan will age out after 10 min
        }
      }
    }

    return null;
  },
});

