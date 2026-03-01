/**
 * Data access for AI proxy rate limiting (anon_device_usage table)
 * and proxy token management (proxy_tokens table).
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

const DEVICE_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_ADDRESS_KEY_LENGTH = 128;
const CLIENT_ADDRESS_KEY_PATTERN = /^[0-9a-fA-F:.]+$/;

const consumeDeviceAllowanceResultValidator = v.object({
  allowed: v.boolean(),
  requestCount: v.number(),
  remaining: v.number(),
  firstRequestAt: v.number(),
  lastRequestAt: v.number(),
});

const normalizeClientAddressKey = (value: string | undefined) => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CLIENT_ADDRESS_KEY_LENGTH ||
    !CLIENT_ADDRESS_KEY_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
};

async function hashDeviceId(
  deviceId: string,
  clientAddressKey?: string,
): Promise<string> {
  const salt = process.env.ANON_DEVICE_ID_HASH_SALT?.trim();
  if (!salt) {
    throw new Error("Missing ANON_DEVICE_ID_HASH_SALT");
  }
  const normalizedAddressKey = normalizeClientAddressKey(clientAddressKey);
  const materialBase = normalizedAddressKey
    ? `${deviceId}|addr:${normalizedAddressKey}`
    : deviceId;
  const material = `${salt}:${materialBase}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hashHex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hashHex}`;
}

export const getDeviceUsage = internalQuery({
  args: {
    deviceId: v.string(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey);
    const row = await ctx.db
      .query("anon_device_usage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceHash))
      .unique();
    if (!row) return null;
    if (Date.now() - row.lastRequestAt > DEVICE_USAGE_RETENTION_MS) {
      return null;
    }
    return {
      requestCount: row.requestCount,
      firstRequestAt: row.firstRequestAt,
      lastRequestAt: row.lastRequestAt,
    };
  },
});

export const incrementDeviceUsage = internalMutation({
  args: {
    deviceId: v.string(),
    clientAddressKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey);
    const existing = await ctx.db
      .query("anon_device_usage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceHash))
      .unique();

    const now = Date.now();

    if (existing) {
      const stale = now - existing.lastRequestAt > DEVICE_USAGE_RETENTION_MS;
      await ctx.db.patch(existing._id, {
        requestCount: stale ? 1 : existing.requestCount + 1,
        firstRequestAt: stale ? now : existing.firstRequestAt,
        lastRequestAt: now,
      });
    } else {
      await ctx.db.insert("anon_device_usage", {
        deviceId: deviceHash,
        requestCount: 1,
        firstRequestAt: now,
        lastRequestAt: now,
      });
    }

    return null;
  },
});

/**
 * Atomically checks and consumes one anonymous request allowance.
 */
export const consumeDeviceAllowance = internalMutation({
  args: {
    deviceId: v.string(),
    maxRequests: v.number(),
    clientAddressKey: v.optional(v.string()),
  },
  returns: consumeDeviceAllowanceResultValidator,
  handler: async (ctx, args) => {
    const maxRequests = Math.max(1, Math.floor(args.maxRequests));
    const deviceHash = await hashDeviceId(args.deviceId, args.clientAddressKey);
    const existing = await ctx.db
      .query("anon_device_usage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceHash))
      .unique();

    const now = Date.now();
    let requestCount = 1;
    let firstRequestAt = now;

    if (existing) {
      const stale = now - existing.lastRequestAt > DEVICE_USAGE_RETENTION_MS;
      requestCount = stale ? 1 : existing.requestCount + 1;
      firstRequestAt = stale ? now : existing.firstRequestAt;
      await ctx.db.patch(existing._id, {
        requestCount,
        firstRequestAt,
        lastRequestAt: now,
      });
    } else {
      await ctx.db.insert("anon_device_usage", {
        deviceId: deviceHash,
        requestCount,
        firstRequestAt,
        lastRequestAt: now,
      });
    }

    return {
      allowed: requestCount <= maxRequests,
      requestCount,
      remaining: Math.max(0, maxRequests - requestCount),
      firstRequestAt,
      lastRequestAt: now,
    };
  },
});

// ─── Proxy Token Management ──────────────────────────────────────────────────

const PROXY_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PROXY_TOKEN_AUDIENCE = "stella:llm-proxy";
const PROXY_TOKEN_BYTES = 32;

function generateTokenString(): string {
  const bytes = new Uint8Array(PROXY_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const mintProxyToken = internalMutation({
  args: {
    ownerId: v.string(),
    agentType: v.string(),
    runId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const token = generateTokenString();
    const expiresAt = now + PROXY_TOKEN_TTL_MS;

    const identity = await ctx.auth.getUserIdentity();
    const isAnonymous = identity ? (identity as Record<string, unknown>).isAnonymous === true : false;

    await ctx.db.insert("proxy_tokens", {
      ownerId: args.ownerId,
      token,
      agentType: args.agentType,
      runId: args.runId,
      audience: PROXY_TOKEN_AUDIENCE,
      expiresAt,
      revoked: false,
      createdAt: now,
      isAnonymous,
    });

    return { token, expiresAt };
  },
});

export const validateProxyToken = internalQuery({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("proxy_tokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (!row) {
      return { valid: false as const, reason: "Token not found" };
    }

    if (row.revoked) {
      return { valid: false as const, reason: "Token revoked" };
    }

    if (Date.now() > row.expiresAt) {
      return { valid: false as const, reason: "Token expired" };
    }

    if (row.audience !== PROXY_TOKEN_AUDIENCE) {
      return { valid: false as const, reason: "Invalid audience" };
    }

    return {
      valid: true as const,
      ownerId: row.ownerId,
      agentType: row.agentType,
      runId: row.runId,
      isAnonymous: row.isAnonymous ?? false,
    };
  },
});

export const revokeProxyToken = internalMutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("proxy_tokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (row) {
      await ctx.db.patch(row._id, { revoked: true });
    }

    return null;
  },
});

export const revokeProxyTokensByRunId = internalMutation({
  args: {
    runId: v.string(),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const tokens = await ctx.db
      .query("proxy_tokens")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
      .collect();

    for (const token of tokens) {
      if (token.runId === args.runId && !token.revoked) {
        await ctx.db.patch(token._id, { revoked: true });
      }
    }

    return null;
  },
});

export const cleanupExpiredProxyTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("proxy_tokens")
      .withIndex("by_expiresAt")
      .filter((q) => q.lt(q.field("expiresAt"), now - 60_000))
      .take(100);

    for (const token of expired) {
      await ctx.db.delete(token._id);
    }

    return expired.length;
  },
});

// ─── Per-user rate limiting for proxy ─────────────────────────────────────────

const PROXY_RATE_WINDOW_MS = 60_000; // 1 minute window
const DEFAULT_PROXY_TOKENS_PER_MINUTE = 1_000_000; // configurable via env

export const checkProxyRateLimit = internalMutation({
  args: {
    ownerId: v.string(),
    estimatedTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limitStr = process.env.PROXY_TOKENS_PER_MINUTE;
    const limit = limitStr ? parseInt(limitStr, 10) : DEFAULT_PROXY_TOKENS_PER_MINUTE;
    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true };
    }

    const now = Date.now();
    const windowStart = now - PROXY_RATE_WINDOW_MS;

    // Sum recent usage for this owner
    const recentLogs = await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId).gte("createdAt", windowStart),
      )
      .collect();

    let totalTokens = 0;
    for (const log of recentLogs) {
      totalTokens += log.totalTokens ?? 0;
    }

    if (totalTokens + (args.estimatedTokens ?? 0) > limit) {
      return {
        allowed: false,
        retryAfterMs: PROXY_RATE_WINDOW_MS,
      };
    }

    return { allowed: true };
  },
});
