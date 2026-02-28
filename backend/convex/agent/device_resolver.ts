import { mutation, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { ConvexError, v } from "convex/values";
import { requireSensitiveUserId } from "../auth";

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

// ---------------------------------------------------------------------------
// Public Mutations — called from Electron app
// ---------------------------------------------------------------------------

/**
 * Heartbeat: upsert the local device record with online = true.
 * Called every 30s from the Electron runner.
 */
export const heartbeat = mutation({
  args: {
    deviceId: v.string(),
    platform: v.optional(v.string()),
    signedAtMs: v.number(),
    signature: v.string(),
    publicKey: v.string(),
  },
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

    const existing = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();

    if (existing?.devicePublicKey && existing.devicePublicKey !== args.publicKey) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Device key mismatch for owner.",
      });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        deviceId: args.deviceId,
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
 * Go offline: mark the local device as offline.
 * Called from Electron app on before-quit / runner stop.
 */
export const goOffline = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireSensitiveUserId(ctx);
    const device = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();

    if (device) {
      await ctx.db.patch(device._id, { online: false });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal Queries — used by channels, heartbeats, crons
// ---------------------------------------------------------------------------

/**
 * Resolve the best execution target for an owner.
 * 1. Local device online → return its deviceId
 * 2. Cloud device running → return its spriteName
 * 3. Neither → null/null (backend-only tools)
 */
export const resolveExecutionTarget = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args): Promise<{
    targetDeviceId: string | null;
    spriteName: string | null;
  }> => {
    // Step 1: Check local device
    const device = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();

    if (device?.online) {
      return { targetDeviceId: device.deviceId, spriteName: null };
    }

    // Step 2: Check cloud device (ungated — if it exists and is usable, use it)
    const spriteName: string | null = await ctx.runQuery(
      internal.agent.cloud_devices.resolveForOwnerUngated,
      { ownerId: args.ownerId },
    );

    if (spriteName) {
      return { targetDeviceId: null, spriteName };
    }

    // Step 3: No execution target
    return { targetDeviceId: null, spriteName: null };
  },
});

/**
 * Get device status for system prompt injection.
 * Returns a summary the orchestrator can reason about.
 */
export const getDeviceStatus = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();

    const cloudRecords = await ctx.db
      .query("cloud_devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .collect();

    // Find best cloud device status
    let cloudStatus: string | null = null;
    let cloudAvailable = false;
    for (const record of cloudRecords) {
      if (record.status !== "error") {
        cloudAvailable = true;
        cloudStatus = record.status;
        break;
      }
      cloudStatus = record.status;
    }

    return {
      localOnline: device?.online ?? false,
      cloudAvailable,
      cloudStatus,
    };
  },
});
