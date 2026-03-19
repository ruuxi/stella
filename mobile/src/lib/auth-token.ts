import { authClient } from "./auth-client";
import { assert, assertObject } from "./assert";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let inflightTokenPromise: Promise<string> | null = null;

const REFRESH_MARGIN_MS = 60_000;

const decodeJwtPayload = (token: string) => {
  const payload = token.split(".")[1];
  assert(payload, "Token payload is unavailable.");
  assert(typeof globalThis.atob === "function", "Token payload is unavailable.");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const parsed = JSON.parse(globalThis.atob(`${normalized}${padding}`)) as unknown;
  assertObject(parsed, "Token payload is unavailable.");
  assert(typeof parsed.exp === "number", "Token expiration is unavailable.");
  return parsed.exp;
};

async function loadConvexToken() {
  const convex = (authClient as unknown as {
    convex: { token(): Promise<{ data?: { token?: string } }> };
  }).convex;
  const result = await convex.token();
  const token = result.data?.token;
  assert(token, "You need to sign in again.");
  cachedToken = token;
  cachedTokenExpiresAt = decodeJwtPayload(token) * 1000 - REFRESH_MARGIN_MS;
  return token;
}

export async function getConvexToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  inflightTokenPromise = loadConvexToken().finally(() => {
    inflightTokenPromise = null;
  });

  return inflightTokenPromise;
}

export function clearCachedToken() {
  cachedToken = "";
  cachedTokenExpiresAt = 0;
  inflightTokenPromise = null;
}
