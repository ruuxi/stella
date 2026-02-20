/**
 * Auth token helper for custom HTTP endpoints (e.g. /api/chat, /api/synthesize,
 * /api/speech-to-text).
 *
 * BetterAuth crossDomain stores session cookies in localStorage, NOT as browser
 * cookies. So `credentials: "include"` sends nothing to the Convex site domain.
 * Instead, we must fetch a Convex JWT via the BetterAuth token endpoint and
 * include it as an Authorization header.
 */

import { authClient } from "@/lib/auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// JWT lifetime is 5 minutes; refresh 60s early to avoid races
const REFRESH_MARGIN_MS = 60_000;

/**
 * Get a valid Convex JWT for use in HTTP endpoint Authorization headers.
 * Caches the token and refreshes it before expiry.
 */
export async function getConvexToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  try {
    const result = await (authClient as any).convex.token();
    const token: string | undefined = result?.data?.token;
    if (!token) {
      cachedToken = null;
      tokenExpiresAt = 0;
      return null;
    }

    cachedToken = token;
    // Parse JWT exp claim for precise refresh timing
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      const expMs = (payload.exp ?? 0) * 1000;
      tokenExpiresAt = expMs - REFRESH_MARGIN_MS;
    } catch {
      // Fallback: 4-minute cache if we can't parse
      tokenExpiresAt = Date.now() + 4 * 60 * 1000;
    }

    return token;
  } catch {
    cachedToken = null;
    tokenExpiresAt = 0;
    return null;
  }
}

/**
 * Build headers for authenticated HTTP requests to Convex HTTP endpoints.
 */
export async function getAuthHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getConvexToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Clear cached token (e.g. on sign-out). */
export function clearCachedToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
}
