/**
 * Data access for AI proxy rate limiting (anon_device_usage table).
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

const DEVICE_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function hashDeviceId(deviceId: string): Promise<string> {
  const salt = process.env.ANON_DEVICE_ID_HASH_SALT ?? "";
  const material = salt ? `${salt}:${deviceId}` : deviceId;
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
  args: { deviceId: v.string() },
  returns: v.union(
    v.object({
      requestCount: v.number(),
      firstRequestAt: v.number(),
      lastRequestAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId);
    const row = await ctx.db
      .query("anon_device_usage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceHash))
      .first();
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
  args: { deviceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const deviceHash = await hashDeviceId(args.deviceId);
    const existing = await ctx.db
      .query("anon_device_usage")
      .withIndex("by_deviceId", (q) => q.eq("deviceId", deviceHash))
      .first();

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
