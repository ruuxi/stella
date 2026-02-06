import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { processIncomingMessage, processLinkCode } from "./channel_utils";
import { retryFetch } from "./retry_fetch";

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

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

/**
 * Get OAuth2 access token using service account key.
 * Creates a self-signed JWT, exchanges it for an access token.
 */
async function getGoogleAccessToken(): Promise<string> {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60_000) {
    return cachedGoogleToken.token;
  }

  const keyJson = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("Missing GOOGLE_CHAT_SERVICE_ACCOUNT_KEY");

  const key = JSON.parse(keyJson);
  const now = Math.floor(Date.now() / 1000);

  // Build JWT header and claims
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/chat.bot",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encode = (obj: unknown) => {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };

  const headerB64 = encode(header);
  const claimsB64 = encode(claims);
  const unsigned = `${headerB64}.${claimsB64}`;

  // Import private key and sign
  const pemContents = key.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyData = base64UrlDecode(
    pemContents.replace(/\+/g, "-").replace(/\//g, "_"),
  );

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${unsigned}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await retryFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const tokenData = await tokenRes.json();
  const expiresIn = Number(tokenData.expires_in);
  cachedGoogleToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + ((Number.isFinite(expiresIn) ? expiresIn : 3600) - 60) * 1000,
  };
  return tokenData.access_token;
}

const sendGoogleChatMessage = async (spaceName: string, text: string) => {
  try {
    const accessToken = await getGoogleAccessToken();
    // Google Chat message limit is 4096 chars
    const maxLen = 4096;
    const truncated = text.length > maxLen
      ? text.slice(0, maxLen - 20) + "\n\n... (truncated)"
      : text;

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

    if (result === "invalid_code") {
      await sendGoogleChatMessage(args.spaceName, "Invalid or expired code. Please generate a new one in Stella Settings.");
    } else if (result === "already_linked") {
      await sendGoogleChatMessage(args.spaceName, "Your Google Chat account is already linked to Stella!");
    } else if (result === "linking_disabled") {
      await sendGoogleChatMessage(args.spaceName, "Google Chat linking is currently disabled.");
    } else if (result === "not_allowed") {
      await sendGoogleChatMessage(args.spaceName, "This Google Chat account is not allowed to link.");
    } else {
      await sendGoogleChatMessage(args.spaceName, "Linked! You can now message Stella directly here.");
    }
  },
});

export const handleIncomingMessage = internalAction({
  args: {
    spaceName: v.string(),
    googleUserId: v.string(),
    text: v.string(),
    displayName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const result = await processIncomingMessage({
        ctx,
        provider: "google_chat",
        externalUserId: args.googleUserId,
        text: args.text,
      });

      if (!result) {
        await sendGoogleChatMessage(
          args.spaceName,
          "Your account isn't linked yet. Send `link CODE` with your 6-digit code from Stella Settings.",
        );
        return;
      }

      await sendGoogleChatMessage(args.spaceName, result.text);
    } catch (error) {
      console.error("[google_chat] Agent turn failed:", error);
      await sendGoogleChatMessage(args.spaceName, "Sorry, something went wrong. Please try again.");
    }
  },
});
