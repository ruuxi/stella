/**
 * Auth token helper for custom HTTP endpoints (e.g. /api/chat,
 * /api/speech-to-text/session).
 *
 * BetterAuth crossDomain stores session cookies in localStorage, NOT as browser
 * cookies. So `credentials: "include"` sends nothing to the Convex site domain.
 * Instead, we must fetch a Convex JWT via the BetterAuth token endpoint and
 * include it as an Authorization header.
 */

import { configurePiRuntime } from "@/platform/electron/device";
import { getJwtExpMs } from "@/shared/lib/jwt";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;

// JWT lifetime is 5 minutes; refresh 60s early to avoid races
const REFRESH_MARGIN_MS = 60_000;

type GetConvexTokenOptions = {
  forceRefresh?: boolean;
};

/**
 * Get a valid Convex JWT for use in HTTP endpoint Authorization headers.
 * Caches the token and refreshes it before expiry.
 */
export async function getConvexToken(
  options: GetConvexTokenOptions = {},
): Promise<string | null> {
  const forceRefresh = options.forceRefresh ?? false;

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  if (forceRefresh) {
    cachedToken = null;
    tokenExpiresAt = 0;
  }

  inflightTokenPromise = (async () => {
    try {
      await configurePiRuntime();
      const token = await window.electronAPI?.system.getConvexAuthToken?.();
      if (!token) {
        cachedToken = null;
        tokenExpiresAt = 0;
        return null;
      }

      cachedToken = token;
      // Parse JWT exp claim for precise refresh timing
      try {
        tokenExpiresAt = getJwtExpMs(token) - REFRESH_MARGIN_MS;
      } catch (err) {
        console.debug(
          "[auth-token] JWT parse failed, using 4-minute cache:",
          (err as Error).message,
        );
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
