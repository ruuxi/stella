import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { handleConnectorIncomingMessage } from "./message_pipeline";
import { formatLinkCodeResultMessage, processLinkCode } from "./link_codes";
import { retryFetch } from "../lib/retry_fetch";
import { channelAttachmentValidator, optionalChannelEnvelopeValidator } from "../shared_validators";
import { TEAMS_MAX_MESSAGE_CHARS, truncateForConnector } from "./connector_constants";
import { getTeamsBotToken, verifyRsaJwtWithCachedJwks } from "./connector_auth";

// ---------------------------------------------------------------------------
// Azure AD JWT Verification (Bot Framework)
// ---------------------------------------------------------------------------

const BOTFRAMEWORK_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

let cachedOpenIdConfig: { jwks_uri: string; fetchedAt: number } | null = null;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

async function getBotFrameworkJwksUrl(): Promise<string> {
  // Get OpenID config if not cached
  if (!cachedOpenIdConfig || Date.now() - cachedOpenIdConfig.fetchedAt > CACHE_MS) {
    const configRes = await fetch(BOTFRAMEWORK_OPENID_URL);
    if (!configRes.ok) throw new Error(`Failed to fetch OpenID config: ${configRes.status}`);
    const config = await configRes.json();
    cachedOpenIdConfig = { jwks_uri: config.jwks_uri, fetchedAt: Date.now() };
  }
  return cachedOpenIdConfig.jwks_uri;
}

export async function verifyTeamsToken(
  authHeader: string,
  appId: string,
): Promise<boolean> {
  const validIssuers = [
    "https://api.botframework.com",
    "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
    "https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0",
  ];
  return verifyRsaJwtWithCachedJwks({
    authHeader,
    jwksUrl: await getBotFrameworkJwksUrl(),
    logPrefix: "[teams]",
    validatePayload: (payload, now) =>
      payload.aud === appId
      && (typeof payload.exp !== "number" || payload.exp >= now)
      && typeof payload.iss === "string"
      && validIssuers.includes(payload.iss),
  });
}

// ---------------------------------------------------------------------------
// Teams Bot Framework API Helpers
// ---------------------------------------------------------------------------

const sendTeamsMessage = async (
  serviceUrl: string,
  conversationId: string,
  text: string,
) => {
  try {
    const token = await getTeamsBotToken();
    const truncated = truncateForConnector(text, TEAMS_MAX_MESSAGE_CHARS);

    // Normalize service URL
    const baseUrl = serviceUrl.endsWith("/") ? serviceUrl.slice(0, -1) : serviceUrl;

    const res = await retryFetch(
      `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "message",
          text: truncated,
        }),
      },
    );

    if (!res.ok) {
      console.error("[teams] Failed to send message:", res.status, await res.text());
    }
  } catch (error) {
    console.error("[teams] Send failed:", error);
  }
};

// ---------------------------------------------------------------------------
// Internal Actions (scheduled from webhook)
// ---------------------------------------------------------------------------

export const handleLinkCommand = internalAction({
  args: {
    serviceUrl: v.string(),
    conversationIdTeams: v.string(),
    teamsUserId: v.string(),
    code: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "teams",
      externalUserId: args.teamsUserId,
      code: args.code,
      displayName: args.displayName,
    });

    await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, formatLinkCodeResultMessage(result, {
      providerName: "Teams",
      linkedMessage: "Linked! You can now message Stella directly here.",
    }));
    return null;
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    serviceUrl: v.string(),
    conversationIdTeams: v.string(),
    teamsUserId: v.string(),
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
      provider: "teams",
      externalUserId: args.teamsUserId,
      text: args.text,
      groupId: args.groupId,
      attachments: args.attachments,
      channelEnvelope: args.channelEnvelope,
      respond: args.respond,
      deliveryMeta: {
        serviceUrl: args.serviceUrl,
        conversationIdTeams: args.conversationIdTeams,
      },
      logPrefix: "[teams]",
      notLinkedText: "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
      sendReply: (text) => sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, text),
    });
    return null;
  },
});
