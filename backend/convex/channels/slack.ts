import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { processIncomingMessage } from "./message_pipeline";
import { processLinkCode } from "./link_codes";
import { retryFetch } from "../lib/retry_fetch";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";
import { constantTimeEqual } from "../lib/crypto_utils";
import { SLACK_MAX_MESSAGE_CHARS, truncateForConnector } from "./connector_constants";

// ---------------------------------------------------------------------------
// Slack Signature Verification (HMAC-SHA256)
// ---------------------------------------------------------------------------

export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): Promise<boolean> {
  try {
    // Reject requests older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) return false;

    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(sigBasestring),
    );

    const computed = "v0=" + Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return constantTimeEqual(computed, signature);
  } catch (error) {
    console.error("[slack] Signature verification failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slack API Helpers
// ---------------------------------------------------------------------------

/** Resolve the bot token for a Slack workspace, falling back to the global env var. */
async function resolveSlackToken(
  ctx: { runQuery: ActionCtx["runQuery"] },
  teamId?: string,
): Promise<string | null> {
  if (teamId) {
    const installation = await ctx.runQuery(
      internal.channels.slack_installations.getByTeamId,
      { teamId },
    );
    if (installation) return installation.botToken;
  }
  return process.env.SLACK_BOT_TOKEN ?? null;
}

const sendSlackMessage = async (channel: string, text: string, token: string) => {
  const truncated = truncateForConnector(text, SLACK_MAX_MESSAGE_CHARS);

  const res = await retryFetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text: truncated }),
  });

  if (!res.ok) {
    console.error("[slack] Failed to send message:", res.status, await res.text());
  } else {
    const data = await res.json();
    if (!data.ok) {
      console.error("[slack] API error:", data.error);
    }
  }
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleLinkCommand = internalAction({
  args: {
    slackUserId: v.string(),
    channelId: v.string(),
    code: v.string(),
    displayName: v.optional(v.string()),
    teamId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await resolveSlackToken(ctx, args.teamId);
    if (!token) {
      console.error("[slack] No bot token available for team:", args.teamId);
      return null;
    }

    const result = await processLinkCode({
      ctx,
      provider: "slack",
      externalUserId: args.slackUserId,
      code: args.code,
      displayName: args.displayName,
    });

    if (result === "invalid_code") {
      await sendSlackMessage(args.channelId, "Invalid or expired code. Please generate a new one in Stella Settings.", token);
    } else if (result === "already_linked") {
      await sendSlackMessage(args.channelId, "Your Slack account is already linked to Stella!", token);
    } else if (result === "linking_disabled") {
      await sendSlackMessage(
        args.channelId,
        "Slack linking is disabled while Private Local mode is on. Enable Connected mode in Stella Settings.",
        token,
      );
    } else if (result === "not_allowed") {
      await sendSlackMessage(args.channelId, "This Slack account is not allowed to link.", token);
    } else {
      await sendSlackMessage(args.channelId, "Linked! You can now message Stella directly here.", token);
    }
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    slackUserId: v.string(),
    channelId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    teamId: v.optional(v.string()),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const shouldRespond = args.respond !== false;

    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "slack",
        externalUserId: args.slackUserId,
        text: args.text,
        groupId: args.groupId,
        attachments: args.attachments,
        channelEnvelope: args.channelEnvelope,
        respond: args.respond,
        deliveryMeta: { channelId: args.channelId, teamId: args.teamId },
      });

      if (result?.deferred) return null;

      if (!result) {
        if (!shouldRespond) return null;
        const token = await resolveSlackToken(ctx, args.teamId);
        if (!token) {
          console.error("[slack] No bot token available for team:", args.teamId);
          return null;
        }
        await sendSlackMessage(args.channelId, "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.", token);
        return null;
      }

      if (shouldRespond) {
        const token = await resolveSlackToken(ctx, args.teamId);
        if (!token) {
          console.error("[slack] No bot token available for team:", args.teamId);
          return null;
        }
        await sendSlackMessage(args.channelId, result.text, token);
      }
    } catch (error) {
      console.error("[slack] Agent turn failed:", error);
      if (shouldRespond) {
        const token = await resolveSlackToken(ctx, args.teamId);
        if (!token) {
          console.error("[slack] No bot token available for team:", args.teamId);
          return null;
        }
        await sendSlackMessage(args.channelId, "Sorry, something went wrong. Please try again.", token);
      }
    }
    return null;
  },
});
