import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireBoundedString } from "./shared_validators";

export const MOBILE_BRIDGE_LEASE_MS = 150_000;
/**
 * Hard caps on the `baseUrls` array stored on each registration row. The
 * array is unbounded by schema (`v.array(v.string())`); without these caps a
 * misbehaving client could grow the document until it hits the 1MB Convex
 * document limit and corrupts the row for every subsequent heartbeat.
 */
const MAX_BASE_URLS_PER_REGISTRATION = 8;
const MAX_BASE_URL_LENGTH = 2048;

/**
 * Trim, dedupe and cap the caller-provided list so the persisted array stays
 * tiny and predictable. Preserves caller order so the most recently
 * registered URL keeps priority for downstream consumers.
 */
const sanitizeBaseUrls = (raw: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    requireBoundedString(trimmed, "baseUrl", MAX_BASE_URL_LENGTH);
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_BASE_URLS_PER_REGISTRATION) break;
  }
  if (out.length === 0) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "baseUrls must contain at least one non-empty URL",
    });
  }
  return out;
};

const bridgeRegistrationValidator = v.object({
  deviceId: v.string(),
  baseUrls: v.array(v.string()),
  updatedAt: v.number(),
  leaseExpiresAt: v.number(),
  platform: v.optional(v.string()),
  available: v.boolean(),
});

const getLeaseExpiresAt = (updatedAt: number) =>
  updatedAt + MOBILE_BRIDGE_LEASE_MS;

const loadLatestRegistration = async (ctx: QueryCtx, ownerId: string) => {
  const [registration] = await ctx.db
    .query("mobile_bridge_registrations")
    .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
    .order("desc")
    .take(1);
  return registration ?? null;
};

const resolveRegistrationPlatform = async (
  ctx: QueryCtx,
  args: { ownerId: string; deviceId: string; platform?: string },
) => {
  if (args.platform) {
    return args.platform;
  }

  const device = await ctx.db
    .query("devices")
    .withIndex("by_ownerId_and_deviceId", (q) =>
      q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
    )
    .unique();
  return device?.platform ?? undefined;
};

export const upsertRegistration = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    baseUrls: v.array(v.string()),
    updatedAt: v.number(),
    platform: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx: MutationCtx, args) => {
    const sanitizedBaseUrls = sanitizeBaseUrls(args.baseUrls);
    const existing = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        baseUrls: sanitizedBaseUrls,
        updatedAt: args.updatedAt,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
      });
      return null;
    }

    await ctx.db.insert("mobile_bridge_registrations", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      baseUrls: sanitizedBaseUrls,
      updatedAt: args.updatedAt,
      ...(args.platform !== undefined ? { platform: args.platform } : {}),
    });
    return null;
  },
});

export const clearRegistration = internalMutation({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx: MutationCtx, args) => {
    const existing = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

export const getLatestRegistrationForOwner = internalQuery({
  args: {
    ownerId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), bridgeRegistrationValidator),
  handler: async (ctx: QueryCtx, args) => {
    const registration = await loadLatestRegistration(ctx, args.ownerId);
    if (!registration) {
      return null;
    }

    const platform = await resolveRegistrationPlatform(ctx, {
      ownerId: args.ownerId,
      deviceId: registration.deviceId,
      platform: registration.platform,
    });

    return {
      deviceId: registration.deviceId,
      baseUrls: registration.baseUrls,
      updatedAt: registration.updatedAt,
      leaseExpiresAt: getLeaseExpiresAt(registration.updatedAt),
      ...(platform ? { platform } : {}),
      available: getLeaseExpiresAt(registration.updatedAt) > args.nowMs,
    };
  },
});

export const getRegistrationForOwnerDevice = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), bridgeRegistrationValidator),
  handler: async (ctx: QueryCtx, args) => {
    const registration = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();
    if (!registration) {
      return null;
    }

    const platform = await resolveRegistrationPlatform(ctx, {
      ownerId: args.ownerId,
      deviceId: registration.deviceId,
      platform: registration.platform,
    });

    return {
      deviceId: registration.deviceId,
      baseUrls: registration.baseUrls,
      updatedAt: registration.updatedAt,
      leaseExpiresAt: getLeaseExpiresAt(registration.updatedAt),
      ...(platform ? { platform } : {}),
      available: getLeaseExpiresAt(registration.updatedAt) > args.nowMs,
    };
  },
});
