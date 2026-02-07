import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./utils";
import { retryFetch } from "../lib/retry_fetch";

// ---------------------------------------------------------------------------
// Azure AD JWT Verification (Bot Framework)
// ---------------------------------------------------------------------------

const BOTFRAMEWORK_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";

let cachedOpenIdConfig: { jwks_uri: string; fetchedAt: number } | null = null;
let cachedJwks: { keys: JsonWebKey[]; fetchedAt: number } | null = null;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchBotFrameworkJwks(): Promise<JsonWebKey[]> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < CACHE_MS) {
    return cachedJwks.keys;
  }

  // Get OpenID config if not cached
  if (!cachedOpenIdConfig || Date.now() - cachedOpenIdConfig.fetchedAt > CACHE_MS) {
    const configRes = await fetch(BOTFRAMEWORK_OPENID_URL);
    if (!configRes.ok) throw new Error(`Failed to fetch OpenID config: ${configRes.status}`);
    const config = await configRes.json();
    cachedOpenIdConfig = { jwks_uri: config.jwks_uri, fetchedAt: Date.now() };
  }

  const jwksRes = await fetch(cachedOpenIdConfig.jwks_uri);
  if (!jwksRes.ok) throw new Error(`Failed to fetch JWKs: ${jwksRes.status}`);
  const data = await jwksRes.json();
  cachedJwks = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

export async function verifyTeamsToken(
  authHeader: string,
  appId: string,
): Promise<boolean> {
  try {
    if (!authHeader.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));

    // Check audience matches our app ID
    if (payload.aud !== appId) return false;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return false;

    // Check issuer (Bot Framework or Azure AD)
    const validIssuers = [
      "https://api.botframework.com",
      "https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/",
      "https://login.microsoftonline.com/d6d49420-f39b-4df7-a1dc-d59a935871db/v2.0",
    ];
    if (!validIssuers.includes(payload.iss)) return false;

    // Find matching key
    const jwks = await fetchBotFrameworkJwks();
    const jwk = jwks.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
    if (!jwk) return false;

    // Import RSA public key and verify
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureBytes = base64UrlDecode(parts[2]);
    const signedContent = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes.buffer as ArrayBuffer,
      signedContent.buffer as ArrayBuffer,
    );
  } catch (error) {
    console.error("[teams] Token verification failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Teams Bot Framework API Helpers
// ---------------------------------------------------------------------------

let cachedBotToken: { token: string; expiresAt: number } | null = null;

async function getTeamsBotToken(): Promise<string> {
  if (cachedBotToken && cachedBotToken.expiresAt > Date.now() + 60000) {
    return cachedBotToken.token;
  }

  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;
  if (!appId || !appPassword) throw new Error("Missing TEAMS_APP_ID or TEAMS_APP_PASSWORD");

  const res = await fetch(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: appId,
        client_secret: appPassword,
        scope: "https://api.botframework.com/.default",
      }).toString(),
    },
  );

  if (!res.ok) {
    throw new Error(`Teams token request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedBotToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

const sendTeamsMessage = async (
  serviceUrl: string,
  conversationId: string,
  text: string,
) => {
  try {
    const token = await getTeamsBotToken();
    // Teams message limit is ~28,000 chars for text
    const maxLen = 28000;
    const truncated = text.length > maxLen
      ? text.slice(0, maxLen - 20) + "\n\n... (truncated)"
      : text;

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
  returns: v.null(),
  handler: async (ctx, args) => {
    const result = await processLinkCode({
      ctx,
      provider: "teams",
      externalUserId: args.teamsUserId,
      code: args.code,
      displayName: args.displayName,
    });

    if (result === "invalid_code") {
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "Invalid or expired code. Please generate a new one in Stella Settings.");
    } else if (result === "already_linked") {
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "Your Teams account is already linked to Stella!");
    } else if (result === "linking_disabled") {
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "Teams linking is currently disabled.");
    } else if (result === "not_allowed") {
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "This Teams account is not allowed to link.");
    } else {
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "Linked! You can now message Stella directly here.");
    }
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "teams",
        externalUserId: args.teamsUserId,
        text: args.text,
      });

      if (!result) {
        await sendTeamsMessage(
          args.serviceUrl,
          args.conversationIdTeams,
          "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
        );
        return null;
      }

      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, result.text);
    } catch (error) {
      console.error("[teams] Agent turn failed:", error);
      await sendTeamsMessage(args.serviceUrl, args.conversationIdTeams, "Sorry, something went wrong. Please try again.");
    }
    return null;
  },
});
