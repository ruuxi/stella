import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { processIncomingMessage } from "./message_pipeline";
import { processLinkCode } from "./link_codes";
import { retryFetch } from "../lib/retry_fetch";
import { base64UrlDecode } from "../lib/crypto_utils";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";
import { GOOGLE_CHAT_MAX_MESSAGE_CHARS, truncateForConnector } from "./connector_constants";
import { getGoogleAccessToken } from "./connector_auth";

// ---------------------------------------------------------------------------
// Google Chat JWT Verification
// ---------------------------------------------------------------------------

// Google's public JWKs for chat service account
const GOOGLE_CHAT_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com";

let cachedJwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const JWKS_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function fetchGoogleJwks(): Promise<JsonWebKey[]> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_MS) {
    return cachedJwks.keys;
  }
  const res = await fetch(GOOGLE_CHAT_JWKS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google JWKs: ${res.status}`);
  const data = await res.json();
  cachedJwks = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

// base64UrlDecode imported from lib/crypto_utils

export async function verifyGoogleChatJwt(
  authHeader: string,
  projectNumber: string,
): Promise<boolean> {
  try {
    if (!authHeader.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));

    // Check issuer and audience
    if (payload.iss !== "chat@system.gserviceaccount.com") return false;
    if (payload.aud !== projectNumber) return false;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return false;
    if (payload.iat && payload.iat > now + 300) return false;

    // Find matching key
    const jwks = await fetchGoogleJwks();
    const jwk = jwks.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!jwk) return false;

    // Import RSA public key
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    // Verify signature
    const signatureBytes = base64UrlDecode(parts[2]);
    const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes.buffer as ArrayBuffer,
      signedContent.buffer as ArrayBuffer,
    );
  } catch (error) {
    console.error("[google_chat] JWT verification failed:", error);
    return false;
  }
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "google_chat",
      externalUserId: args.googleUserId,
      code: args.code,
      displayName: args.displayName,
    });

    if (result === "invalid_code") {
      await sendGoogleChatMessage(args.spaceName, "Invalid or expired code. Please generate a new one in Stella Settings.");
    } else if (result === "already_linked") {
      await sendGoogleChatMessage(args.spaceName, "Your Google Chat account is already linked to Stella!");
    } else if (result === "linking_disabled") {
      await sendGoogleChatMessage(
        args.spaceName,
        "Google Chat linking is disabled while Private Local mode is on. Enable Connected mode in Stella Settings.",
      );
    } else if (result === "not_allowed") {
      await sendGoogleChatMessage(args.spaceName, "This Google Chat account is not allowed to link.");
    } else {
      await sendGoogleChatMessage(args.spaceName, "Linked! You can now message Stella directly here.");
    }
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const shouldRespond = args.respond !== false;

    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "google_chat",
        externalUserId: args.googleUserId,
        text: args.text,
        groupId: args.groupId,
        attachments: args.attachments,
        channelEnvelope: args.channelEnvelope,
        respond: args.respond,
        deliveryMeta: { spaceName: args.spaceName },
      });

      if (result?.deferred) return null;

      if (!result) {
        if (!shouldRespond) return null;
        await sendGoogleChatMessage(
          args.spaceName,
          "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
        );
        return null;
      }

      if (shouldRespond) {
        await sendGoogleChatMessage(args.spaceName, result.text);
      }
    } catch (error) {
      console.error("[google_chat] Agent turn failed:", error);
      if (shouldRespond) {
        await sendGoogleChatMessage(args.spaceName, "Sorry, something went wrong. Please try again.");
      }
    }
    return null;
  },
});
