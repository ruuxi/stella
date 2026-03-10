/**
 * Auth token helper for custom HTTP endpoints (e.g. /api/chat,
 * /api/speech-to-text/ws-token).
 *
 * BetterAuth crossDomain stores session cookies in localStorage, NOT as browser
 * cookies. So `credentials: "include"` sends nothing to the Convex site domain.
 * Instead, we must fetch a Convex JWT via the BetterAuth token endpoint and
 * include it as an Authorization header.
 */

import { authClient } from "@/app/auth/lib/auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;

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

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  inflightTokenPromise = (async () => {
    try {
      // convexClient() plugin adds .convex.token() but isn't reflected in the base type
      const convex = (authClient as unknown as { convex: { token(): Promise<{ data?: { token?: string } }> } }).convex;
      const result = await convex.token();
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
        if (typeof payload.exp !== "number") throw new Error("Missing exp claim");
        const expMs = payload.exp * 1000;
        tokenExpiresAt = expMs - REFRESH_MARGIN_MS;
      } catch (err) {
        console.debug("[auth-token] JWT parse failed, using 4-minute cache:", (err as Error).message);
        tokenExpiresAt = Date.now() + 4 * 60 * 1000;
      }

      return token;
    } catch (err) {
      console.debug("[auth-token] token fetch failed:", (err as Error).message);
      cachedToken = null;
      tokenExpiresAt = 0;
      return null;
    } finally {
      inflightTokenPromise = null;
    }
  })();

  return inflightTokenPromise;
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
  inflightTokenPromise = null;
}
