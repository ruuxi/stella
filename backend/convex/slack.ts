import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./channel_utils";

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

    return computed === signature;
  } catch (error) {
    console.error("[slack] Signature verification failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Slack API Helpers
// ---------------------------------------------------------------------------

const sendSlackMessage = async (channel: string, text: string) => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("[slack] Missing SLACK_BOT_TOKEN");
    return;
  }

  // Slack message limit is 40,000 chars
  const maxLen = 40000;
  const truncated = text.length > maxLen
    ? text.slice(0, maxLen - 20) + "\n\n... (truncated)"
    : text;

  const res = await fetch("https://slack.com/api/chat.postMessage", {
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
  },
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "slack",
      externalUserId: args.slackUserId,
      code: args.code,
      displayName: args.displayName,
    });

    if (result === "invalid_code") {
      await sendSlackMessage(args.channelId, "Invalid or expired code. Please generate a new one in Stella Settings.");
    } else if (result === "already_linked") {
      await sendSlackMessage(args.channelId, "Your Slack account is already linked to Stella!");
    } else {
      await sendSlackMessage(args.channelId, "Linked! You can now message Stella directly here.");
    }
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    slackUserId: v.string(),
    channelId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "slack",
        externalUserId: args.slackUserId,
        text: args.text,
      });

      if (!result) {
        await sendSlackMessage(
          args.channelId,
          "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
        );
        return;
      }

      await sendSlackMessage(args.channelId, result.text);
    } catch (error) {
      console.error("[slack] Agent turn failed:", error);
      await sendSlackMessage(args.channelId, "Sorry, something went wrong. Please try again.");
    }
  },
});
