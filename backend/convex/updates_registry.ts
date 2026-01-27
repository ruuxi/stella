import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";

const getChannel = async (ctx: MutationCtx, channelId: string) => {
  const existing = await ctx.db
    .query("update_channels")
    .withIndex("by_channel", (q) => q.eq("channelId", channelId))
    .take(1);
  return existing[0] ?? null;
};

export const getChannelById = internalQuery({
  args: {
    channelId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("update_channels")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(1);
    return existing[0] ?? null;
  },
});

export const resolveReleaseRecord = internalQuery({
  args: {
    channelId: v.string(),
    releaseId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.releaseId) {
      const direct = await ctx.db
        .query("update_releases")
        .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId as string))
        .take(1);
      return direct[0] ?? null;
    }

    const channel = await ctx.db
      .query("update_channels")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(1);
    const channelRecord = channel[0];

    if (channelRecord?.latestReleaseId) {
      const latest = await ctx.db
        .query("update_releases")
        .withIndex("by_release", (q) => q.eq("releaseId", channelRecord.latestReleaseId as string))
        .take(1);
      if (latest[0]) {
        return latest[0];
      }
    }

    const mostRecent = await ctx.db
      .query("update_releases")
      .withIndex("by_channel_created", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .take(1);
    return mostRecent[0] ?? null;
  },
});

export const upsertChannel = mutation({
  args: {
    channelId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("update_channels")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(1);
    const now = Date.now();
    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, {
        name: args.name,
        description: args.description,
        updatedAt: now,
      });
      return { ok: true, channelId: args.channelId };
    }
    await ctx.db.insert("update_channels", {
      channelId: args.channelId,
      name: args.name,
      description: args.description,
      latestReleaseId: undefined,
      updatedAt: now,
    });
    return { ok: true, channelId: args.channelId };
  },
});

export const listChannels = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("update_channels")
      .withIndex("by_updated")
      .order("desc")
      .take(50);
  },
});

export const upsertReleaseWithChannel = internalMutation({
  args: {
    channelId: v.string(),
    releaseId: v.string(),
    version: v.string(),
    baseGitHead: v.optional(v.string()),
    bundleStorageKey: v.id("_storage"),
    bundleHash: v.string(),
    signature: v.string(),
    authorPublicKey: v.string(),
    notes: v.optional(v.string()),
    manifest: v.any(),
    changedPaths: v.array(v.string()),
    zones: v.array(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const channel = await getChannel(ctx, args.channelId);
    if (channel) {
      await ctx.db.patch(channel._id, {
        latestReleaseId: args.releaseId,
        updatedAt: args.now,
      });
    } else {
      await ctx.db.insert("update_channels", {
        channelId: args.channelId,
        name: args.channelId,
        description: undefined,
        latestReleaseId: args.releaseId,
        updatedAt: args.now,
      });
    }

    const existingRelease = await ctx.db
      .query("update_releases")
      .withIndex("by_release", (q) => q.eq("releaseId", args.releaseId))
      .take(1);

    const releasePayload = {
      releaseId: args.releaseId,
      channelId: args.channelId,
      version: args.version,
      baseGitHead: args.baseGitHead,
      bundleStorageKey: args.bundleStorageKey,
      bundleHash: args.bundleHash,
      signature: args.signature,
      authorPublicKey: args.authorPublicKey,
      notes: args.notes,
      manifest: args.manifest,
      changedPaths: args.changedPaths,
      zones: args.zones,
      updatedAt: args.now,
      source: "upstream",
    };

    if (existingRelease[0]) {
      await ctx.db.patch(existingRelease[0]._id, releasePayload);
      return { ok: true };
    }

    await ctx.db.insert("update_releases", {
      ...releasePayload,
      createdAt: args.now,
    });
    return { ok: true };
  },
});

export const recordAppliedRelease = internalMutation({
  args: {
    releaseId: v.string(),
    channelId: v.string(),
    version: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    conflicts: v.optional(v.number()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("update_applied")
      .withIndex("by_release_device", (q) =>
        q.eq("releaseId", args.releaseId).eq("deviceId", args.deviceId),
      )
      .take(1);

    const status = args.status ?? "applied";

    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, {
        channelId: args.channelId,
        version: args.version,
        changeSetId: args.changeSetId,
        conversationId: args.conversationId,
        conflicts: args.conflicts,
        status,
        updatedAt: now,
        appliedAt: existing[0].appliedAt ?? now,
      });
      return { ok: true };
    }

    await ctx.db.insert("update_applied", {
      releaseId: args.releaseId,
      channelId: args.channelId,
      version: args.version,
      deviceId: args.deviceId,
      changeSetId: args.changeSetId,
      conversationId: args.conversationId,
      conflicts: args.conflicts,
      status,
      appliedAt: now,
      updatedAt: now,
    });
    return { ok: true };
  },
});

