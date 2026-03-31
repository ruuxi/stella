import {
  mutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireSensitiveUserId, requireUserId } from "../auth";

const HEARTBEAT_SIGNATURE_MAX_AGE_MS = 2 * 60_000;

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const verifyHeartbeatSignature = async (args: {
  deviceId: string;
  signedAtMs: number;
  signature: string;
  publicKey: string;
}): Promise<boolean> => {
  try {
    const keyBytes = base64ToBytes(args.publicKey);
    const sigBytes = base64ToBytes(args.signature);
    const message = new TextEncoder().encode(`${args.deviceId}:${args.signedAtMs}`);
    const key = await crypto.subtle.importKey(
      "spki",
      keyBytes.buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      sigBytes.buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
};

const loadDeviceRow = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deviceId: string,
) => {
  return await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();
};

const listDevicesForOwner = async (ctx: QueryCtx, ownerId: string) => {
  return await ctx.db
    .query("devices")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .collect();
};

const pickBestOnlineTarget = (
  rows: Array<{
    deviceId: string;
    online: boolean;
    lastSignedAtMs?: number;
  }>,
): string | null => {
  const online = rows.filter((r) => r.online && r.deviceId);
  if (online.length === 0) {
    const fallback = rows
      .filter((r) => r.deviceId)
      .sort((a, b) => (b.lastSignedAtMs ?? 0) - (a.lastSignedAtMs ?? 0))[0];
    return fallback?.deviceId ?? null;
  }
  const sorted = online.sort(
    (a, b) => (b.lastSignedAtMs ?? 0) - (a.lastSignedAtMs ?? 0),
  );
  return sorted[0]?.deviceId ?? null;
};

// ---------------------------------------------------------------------------
// Public Mutations - called from Electron app
// ---------------------------------------------------------------------------

/**
 * Heartbeat: upsert the local device record with online = true.
 */
export const heartbeat = mutation({
  args: {
    deviceId: v.string(),
    platform: v.optional(v.string()),
    signedAtMs: v.number(),
    signature: v.string(),
    publicKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    const now = Date.now();
    if (Math.abs(now - args.signedAtMs) > HEARTBEAT_SIGNATURE_MAX_AGE_MS) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Heartbeat signature timestamp expired.",
      });
    }
    const signatureOk = await verifyHeartbeatSignature({
      deviceId: args.deviceId,
      signedAtMs: args.signedAtMs,
      signature: args.signature,
      publicKey: args.publicKey,
    });
    if (!signatureOk) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Invalid device heartbeat signature.",
      });
    }

    const existing = await loadDeviceRow(ctx, ownerId, args.deviceId);

    if (existing?.devicePublicKey && existing.devicePublicKey !== args.publicKey) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Device key mismatch for this machine.",
      });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        devicePublicKey: args.publicKey,
        lastSignedAtMs: args.signedAtMs,
        online: true,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
      });
    } else {
      await ctx.db.insert("devices", {
        ownerId,
        deviceId: args.deviceId,
        devicePublicKey: args.publicKey,
        lastSignedAtMs: args.signedAtMs,
        online: true,
        platform: args.platform,
      });
    }
    return null;
  },
});

/**
 * Register: upsert a device record for the authenticated user.
 * No Ed25519 signing required — auth token is sufficient.
 */
export const registerDevice = mutation({
  args: {
    deviceId: v.string(),
    platform: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);

    const existing = await loadDeviceRow(ctx, ownerId, args.deviceId);

    if (existing) {
      await ctx.db.patch(existing._id, {
        online: true,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
      });
    } else {
      await ctx.db.insert("devices", {
        ownerId,
        deviceId: args.deviceId,
        online: true,
        platform: args.platform,
      });
    }
    return null;
  },
});

/**
 * Go offline: mark this desktop machine as offline.
 */
export const goOffline = mutation({
  args: {
    deviceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const device = await loadDeviceRow(ctx, ownerId, args.deviceId);

    if (device) {
      await ctx.db.patch(device._id, { online: false });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal Queries - used by channels, schedulers, and agent execution
// ---------------------------------------------------------------------------

/**
 * Resolve execution target for connector / remote turns.
 * Prefers conversation affinity when the last user_message device is still registered.
 */
export const resolveExecutionTarget = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    targetDeviceId: string | null;
  }> => {
    const rows = await listDevicesForOwner(ctx, args.ownerId);
    if (rows.length === 0) {
      return { targetDeviceId: null };
    }

    let preferred: string | null = null;
    const convId = args.conversationId;
    if (convId !== undefined) {
      const conversationId: Id<"conversations"> = convId;
      const event = await ctx.db
        .query("events")
        .withIndex("by_conversationId_and_type_and_timestamp", (q) =>
          q.eq("conversationId", conversationId).eq("type", "user_message"),
        )
        .order("desc")
        .first();
      const fromEvent =
        typeof event?.deviceId === "string" ? event.deviceId.trim() : "";
      if (fromEvent) {
        const match = rows.find((r) => r.deviceId === fromEvent);
        if (match?.deviceId) {
          preferred = match.deviceId;
        }
      }
    }

    const target =
      preferred && rows.some((r) => r.deviceId === preferred && r.online)
        ? preferred
        : pickBestOnlineTarget(rows);

    console.log(
      `[device_resolver:trace] ownerId=${args.ownerId}, conversationId=${args.conversationId ?? "none"}, devices=${rows.length}, targetDeviceId=${target}`,
    );

    return { targetDeviceId: target };
  },
});

/**
 * Get device status for system prompt injection (any desktop online).
 */
export const getDeviceStatus = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const rows = await listDevicesForOwner(ctx, args.ownerId);
    const localOnline = rows.some((r) => r.online);
    return { localOnline };
  },
});
