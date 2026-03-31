import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const MOBILE_BRIDGE_STALE_MS = 150_000;

const bridgeRegistrationValidator = v.object({
  deviceId: v.string(),
  baseUrls: v.array(v.string()),
  updatedAt: v.number(),
  platform: v.optional(v.string()),
  available: v.boolean(),
});

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
    const existing = await ctx.db
      .query("mobile_bridge_registrations")
      .withIndex("by_ownerId_and_deviceId", (q) =>
        q.eq("ownerId", args.ownerId).eq("deviceId", args.deviceId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        baseUrls: args.baseUrls,
        updatedAt: args.updatedAt,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
      });
      return null;
    }

    await ctx.db.insert("mobile_bridge_registrations", {
      ownerId: args.ownerId,
      deviceId: args.deviceId,
      baseUrls: args.baseUrls,
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
      ...(platform ? { platform } : {}),
      available: registration.updatedAt + MOBILE_BRIDGE_STALE_MS > Date.now(),
    };
  },
});

export const getRegistrationForOwnerDevice = internalQuery({
  args: {
    ownerId: v.string(),
    deviceId: v.string(),
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
      ...(platform ? { platform } : {}),
      available: registration.updatedAt + MOBILE_BRIDGE_STALE_MS > Date.now(),
    };
  },
});
