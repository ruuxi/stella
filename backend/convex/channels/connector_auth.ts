/**
 * Shared OAuth / JWT auth helpers for connectors.
 *
 * google_chat.ts, teams.ts, and connector_delivery.ts all import from here
 * instead of maintaining their own copies.
 */
import { retryFetch } from "../lib/retry_fetch";
import { base64UrlDecode } from "../lib/crypto_utils";

// ─── Constants ───────────────────────────────────────────────────────────────
const GOOGLE_JWT_EXPIRATION_SECONDS = 3600;
const TOKEN_REFRESH_BUFFER_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const JWKS_CACHE_MS = 60 * 60 * 1000;

const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();

const fetchCachedJwks = async (url: string): Promise<JsonWebKey[]> => {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_MS) {
    return cached.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch JWKs: ${res.status}`);
  const data = await res.json();
  const keys = Array.isArray(data.keys) ? data.keys as JsonWebKey[] : [];
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
};

export async function verifyRsaJwtWithCachedJwks(args: {
  authHeader: string;
  jwksUrl: string;
  validatePayload: (payload: Record<string, unknown>, nowSeconds: number) => boolean;
  logPrefix: string;
}): Promise<boolean> {
  try {
    if (!args.authHeader.startsWith("Bearer ")) return false;
    const token = args.authHeader.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as Record<string, unknown>;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as Record<string, unknown>;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!args.validatePayload(payload, nowSeconds)) return false;

    const kid = typeof header.kid === "string" ? header.kid : null;
    if (!kid) return false;
    const jwks = await fetchCachedJwks(args.jwksUrl);
    const jwk = jwks.find((key) => (key as JsonWebKey & { kid?: string }).kid === kid);
    if (!jwk) return false;

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
    console.error(`${args.logPrefix} JWT verification failed:`, error);
    return false;
  }
}

// ─── Google Chat Service Account JWT Auth ────────────────────────────────────

// Module-level cache: cold starts reset to null; fallback is a fresh token fetch.
let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

/**
 * Get OAuth2 access token using Google service account key.
 * Creates a self-signed JWT, exchanges it for an access token.
 */
export async function getGoogleAccessToken(): Promise<string> {
  if (
    cachedGoogleToken &&
    cachedGoogleToken.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedGoogleToken.token;
  }

  const keyJson = process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("Missing GOOGLE_CHAT_SERVICE_ACCOUNT_KEY");

  const key = JSON.parse(keyJson);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/chat.bot",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + GOOGLE_JWT_EXPIRATION_SECONDS,
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

  const tokenRes = await retryFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    throw new Error(
      `Google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }

  const tokenData = await tokenRes.json();
  const expiresIn = Number(tokenData.expires_in);
  cachedGoogleToken = {
    token: tokenData.access_token,
    expiresAt:
      Date.now() +
      ((Number.isFinite(expiresIn) ? expiresIn : DEFAULT_TOKEN_LIFETIME_SECONDS) - 60) * 1000,
  };
  return tokenData.access_token;
}

// ─── Teams Bot Framework Token Auth ──────────────────────────────────────────

// Module-level cache: cold starts reset to null; fallback is a fresh token fetch.
let cachedBotToken: { token: string; expiresAt: number } | null = null;

export async function getTeamsBotToken(): Promise<string> {
  if (cachedBotToken && cachedBotToken.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return cachedBotToken.token;
  }

  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;
  if (!appId || !appPassword)
    throw new Error("Missing TEAMS_APP_ID or TEAMS_APP_PASSWORD");

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
    throw new Error(
      `Teams token request failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = await res.json();
  cachedBotToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}
