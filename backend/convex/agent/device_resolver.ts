import {
  mutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { requireSensitiveUserId, requireUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
  RATE_STANDARD,
} from "../lib/rate_limits";

const HEARTBEAT_SIGNATURE_MAX_AGE_MS = 2 * 60_000;
const DEVICE_FRESHNESS_MS = 90_000;

const freshDeviceOptionValidator = v.object({
  deviceId: v.string(),
  deviceName: v.string(),
  platform: v.optional(v.string()),
  lastHeartbeatAt: v.number(),
});

type DeviceRow = {
  deviceId: string;
  deviceName?: string;
  online: boolean;
  platform?: string;
  lastHeartbeatAt?: number;
  lastSignedAtMs?: number;
};

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

const loadDeviceProfile = async (
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

const loadDevicePresence = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  deviceId: string,
) => {
  return await ctx.db
    .query("device_presence")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", ownerId).eq("deviceId", deviceId),
    )
    .unique();
};

type DeviceProfileFields = {
  deviceName?: string;
  devicePublicKey?: string;
  platform?: string;
};

const upsertDeviceProfile = async (
  ctx: MutationCtx,
  ownerId: string,
  deviceId: string,
  fields: DeviceProfileFields,
) => {
  const existing = await loadDeviceProfile(ctx, ownerId, deviceId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      ...(fields.deviceName !== undefined ? { deviceName: fields.deviceName } : {}),
      ...(fields.devicePublicKey !== undefined ? { devicePublicKey: fields.devicePublicKey } : {}),
      ...(fields.platform !== undefined ? { platform: fields.platform } : {}),
    });
    return existing;
  }
  const id = await ctx.db.insert("devices", {
    ownerId,
    deviceId,
    ...(fields.deviceName !== undefined ? { deviceName: fields.deviceName } : {}),
    ...(fields.devicePublicKey !== undefined ? { devicePublicKey: fields.devicePublicKey } : {}),
    ...(fields.platform !== undefined ? { platform: fields.platform } : {}),
  });
  return await ctx.db.get(id);
};

type DevicePresenceFields = {
  online: boolean;
  lastHeartbeatAt?: number;
  lastSignedAtMs?: number;
};

const upsertDevicePresence = async (
  ctx: MutationCtx,
  ownerId: string,
  deviceId: string,
  fields: DevicePresenceFields,
) => {
  const now = Date.now();
  const existing = await loadDevicePresence(ctx, ownerId, deviceId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      online: fields.online,
      ...(fields.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: fields.lastHeartbeatAt } : {}),
      ...(fields.lastSignedAtMs !== undefined ? { lastSignedAtMs: fields.lastSignedAtMs } : {}),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("device_presence", {
    ownerId,
    deviceId,
    online: fields.online,
    ...(fields.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: fields.lastHeartbeatAt } : {}),
    ...(fields.lastSignedAtMs !== undefined ? { lastSignedAtMs: fields.lastSignedAtMs } : {}),
    updatedAt: now,
  });
};

// Owners typically have a small handful of devices; cap the scan so this
// stays bounded even if device rows accumulate over time.
const MAX_DEVICES_PER_OWNER_SCAN = 200;

const listDevicesForOwner = async (
  ctx: QueryCtx,
  ownerId: string,
): Promise<DeviceRow[]> => {
  const [profiles, presences] = await Promise.all([
    ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(MAX_DEVICES_PER_OWNER_SCAN),
    ctx.db
      .query("device_presence")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .take(MAX_DEVICES_PER_OWNER_SCAN),
  ]);

  const presenceByDeviceId = new Map<string, typeof presences[number]>();
  for (const presence of presences) {
    presenceByDeviceId.set(presence.deviceId, presence);
  }

  const rows: DeviceRow[] = profiles.map((profile) => {
    const presence = presenceByDeviceId.get(profile.deviceId);
    presenceByDeviceId.delete(profile.deviceId);
    return {
      deviceId: profile.deviceId,
      deviceName: profile.deviceName,
      platform: profile.platform,
      online: presence?.online ?? false,
      lastHeartbeatAt: presence?.lastHeartbeatAt,
      lastSignedAtMs: presence?.lastSignedAtMs,
    };
  });

  // Surface presence rows that lack a profile row (shouldn't normally happen
  // but keeps the merge total) so callers don't silently drop them.
  for (const presence of presenceByDeviceId.values()) {
    rows.push({
      deviceId: presence.deviceId,
      online: presence.online,
      lastHeartbeatAt: presence.lastHeartbeatAt,
      lastSignedAtMs: presence.lastSignedAtMs,
    });
  }

  return rows;
};

const getLastHeartbeatAt = (row: Pick<DeviceRow, "lastHeartbeatAt" | "lastSignedAtMs">) =>
  row.lastHeartbeatAt ?? row.lastSignedAtMs ?? 0;

const isFreshDevice = (row: DeviceRow, nowMs: number) =>
  row.online
  && getLastHeartbeatAt(row) > 0
  && nowMs - getLastHeartbeatAt(row) <= DEVICE_FRESHNESS_MS;

const getDeviceDisplayName = (row: Pick<DeviceRow, "deviceId" | "deviceName" | "platform">) => {
  const explicitName = typeof row.deviceName === "string" ? row.deviceName.trim() : "";
  if (explicitName) return explicitName;
  const platform = typeof row.platform === "string" ? row.platform.trim() : "";
  if (platform) return `${platform}-${row.deviceId.slice(0, 6)}`;
  return `device-${row.deviceId.slice(0, 6)}`;
};

const listFreshDeviceRows = (rows: DeviceRow[], nowMs: number) =>
  rows
    .filter((row) => row.deviceId && isFreshDevice(row, nowMs))
    .sort((a, b) => {
      const tsDiff = getLastHeartbeatAt(b) - getLastHeartbeatAt(a);
      if (tsDiff !== 0) return tsDiff;
      return getDeviceDisplayName(a).localeCompare(getDeviceDisplayName(b));
    });

const pickBestOnlineTarget = (
  rows: DeviceRow[],
  nowMs: number,
): string | null => {
  const sorted = listFreshDeviceRows(rows, nowMs);
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
    deviceName: v.optional(v.string()),
    platform: v.optional(v.string()),
    signedAtMs: v.number(),
    signature: v.string(),
    publicKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    // Heartbeats are intentionally hot (~every 30s per device), but a
    // misbehaving client can still spin and churn both device tables. Use
    // the loose hot-path tier keyed by (owner, device).
    await enforceMutationRateLimit(
      ctx,
      "device_heartbeat",
      `${ownerId}:${args.deviceId}`,
      RATE_HOT_PATH,
    );
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

    const existingProfile = await loadDeviceProfile(ctx, ownerId, args.deviceId);

    if (existingProfile?.devicePublicKey && existingProfile.devicePublicKey !== args.publicKey) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Device key mismatch for this machine.",
      });
    }

    await upsertDeviceProfile(ctx, ownerId, args.deviceId, {
      deviceName: args.deviceName,
      devicePublicKey: args.publicKey,
      platform: args.platform,
    });
    await upsertDevicePresence(ctx, ownerId, args.deviceId, {
      online: true,
      lastHeartbeatAt: now,
      lastSignedAtMs: args.signedAtMs,
    });
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
    deviceName: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "device_register",
      ownerId,
      RATE_STANDARD,
    );
    const now = Date.now();

    await upsertDeviceProfile(ctx, ownerId, args.deviceId, {
      deviceName: args.deviceName,
      platform: args.platform,
    });
    await upsertDevicePresence(ctx, ownerId, args.deviceId, {
      online: true,
      lastHeartbeatAt: now,
    });
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
    await enforceMutationRateLimit(
      ctx,
      "device_go_offline",
      ownerId,
      RATE_STANDARD,
    );
    const presence = await loadDevicePresence(ctx, ownerId, args.deviceId);
    if (presence) {
      await ctx.db.patch(presence._id, {
        online: false,
        updatedAt: Date.now(),
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal Queries - used by channels, schedulers, and agent execution
// ---------------------------------------------------------------------------

export const listFreshDevicesForOwner = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
  },
  returns: v.array(freshDeviceOptionValidator),
  handler: async (ctx, args) => {
    const rows = listFreshDeviceRows(
      await listDevicesForOwner(ctx, args.ownerId),
      args.nowMs,
    );
    return rows.map((row) => ({
      deviceId: row.deviceId,
      deviceName: getDeviceDisplayName(row),
      platform: row.platform,
      lastHeartbeatAt: getLastHeartbeatAt(row),
    }));
  },
});

/**
 * Resolve execution target for connector / remote turns.
 * Prefers conversation affinity when the last user_message device is still registered.
 */
export const resolveExecutionTarget = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    nowMs: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    targetDeviceId: string | null;
  }> => {
    const rows = await listDevicesForOwner(ctx, args.ownerId);
    const freshRows = listFreshDeviceRows(rows, args.nowMs);
    if (freshRows.length === 0) {
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
      preferred && freshRows.some((r) => r.deviceId === preferred)
        ? preferred
        : pickBestOnlineTarget(freshRows, args.nowMs);

    console.log(
      `[device_resolver:trace] ownerId=${args.ownerId}, conversationId=${args.conversationId ?? "none"}, devices=${rows.length}, freshDevices=${freshRows.length}, targetDeviceId=${target}`,
    );

    return { targetDeviceId: target };
  },
});

/**
 * Get device status for system prompt injection (any desktop online).
 * Reads only the high-churn presence table to avoid scanning device profile
 * data we don't need.
 */
export const getDeviceStatus = internalQuery({
  args: { ownerId: v.string(), nowMs: v.number() },
  handler: async (ctx, args) => {
    const presences = await ctx.db
      .query("device_presence")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(MAX_DEVICES_PER_OWNER_SCAN);
    const localOnline = presences.some((row) =>
      isFreshDevice(
        {
          deviceId: row.deviceId,
          online: row.online,
          lastHeartbeatAt: row.lastHeartbeatAt,
          lastSignedAtMs: row.lastSignedAtMs,
        },
        args.nowMs,
      ),
    );
    return { localOnline };
  },
});
