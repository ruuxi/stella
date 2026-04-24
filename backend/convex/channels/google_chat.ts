import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { handleConnectorIncomingMessage } from "./message_pipeline";
import { formatLinkCodeResultMessage, processLinkCode } from "./link_codes";
import { retryFetch } from "../lib/retry_fetch";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";
import { GOOGLE_CHAT_MAX_MESSAGE_CHARS, truncateForConnector } from "./connector_constants";
import { getGoogleAccessToken, verifyRsaJwtWithCachedJwks } from "./connector_auth";

// ---------------------------------------------------------------------------
// Google Chat JWT Verification
// ---------------------------------------------------------------------------

// Google's public JWKs for chat service account
const GOOGLE_CHAT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

export async function verifyGoogleChatJwt(
  authHeader: string,
  projectNumber: string,
): Promise<boolean> {
  return verifyRsaJwtWithCachedJwks({
    authHeader,
    jwksUrl: GOOGLE_CHAT_JWKS_URL,
    logPrefix: "[google_chat]",
    validatePayload: (payload, now) =>
      payload.iss === "chat@system.gserviceaccount.com"
      && payload.aud === projectNumber
      && (typeof payload.exp !== "number" || payload.exp >= now)
      && (typeof payload.iat !== "number" || payload.iat <= now + 300),
  });
}

// ---------------------------------------------------------------------------
// Google Chat API Helpers
// ---------------------------------------------------------------------------

const sendGoogleChatMessage = async (spaceName: string, text: string) => {
  try {
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
      console.error("[google_chat] Failed to send message:", res.status, await res.text());
    }
  } catch (error) {
    console.error("[google_chat] Send failed:", error);
  }
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleLinkCommand = internalAction({
  args: {
    spaceName: v.string(),
    googleUserId: v.string(),
    code: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "google_chat",
      externalUserId: args.googleUserId,
      code: args.code,
      displayName: args.displayName,
    });

    await sendGoogleChatMessage(args.spaceName, formatLinkCodeResultMessage(result, {
      providerName: "Google Chat",
      linkedMessage: "Linked! You can now message Stella directly here.",
    }));
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    spaceName: v.string(),
    googleUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
    groupId: v.optional(v.string()),
    attachments: v.optional(v.array(channelAttachmentValidator)),
    channelEnvelope: optionalChannelEnvelopeValidator,
    respond: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await handleConnectorIncomingMessage({
      ctx,
      provider: "google_chat",
      externalUserId: args.googleUserId,
      text: args.text,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      respond: args.respond,
      deliveryMeta: { spaceName: args.spaceName },
      logPrefix: "[google_chat]",
      notLinkedText: "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
      sendReply: (text) => sendGoogleChatMessage(args.spaceName, text),
    });
    return null;
  },
});
