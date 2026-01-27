import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

const getPackById = async (ctx: MutationCtx, packId: string) => {
  const existing = await ctx.db
    .query("packs")
    .withIndex("by_pack", (q) => q.eq("packId", packId))
    .take(1);
  return existing[0] ?? null;
};

export const getPackVersionByKey = internalQuery({
  args: {
    packId: v.string(),
    version: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pack_versions")
      .withIndex("by_pack_version", (q) =>
        q.eq("packId", args.packId).eq("version", args.version),
      )
      .take(1);
    return existing[0] ?? null;
  },
});

export const upsertPackAndVersion = internalMutation({
  args: {
    packId: v.string(),
    name: v.string(),
    description: v.string(),
    authorPublicKey: v.string(),
    version: v.string(),
    manifest: v.any(),
    bundleStorageKey: v.id("_storage"),
    bundleHash: v.string(),
    signature: v.string(),
    securityReview: v.any(),
    changedPaths: v.array(v.string()),
    zones: v.array(v.string()),
    compatibilityNotes: v.array(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existingPack = await getPackById(ctx, args.packId);
    const packPayload = {
      packId: args.packId,
      name: args.name,
      description: args.description,
      authorPublicKey: args.authorPublicKey,
      latestVersion: args.version,
      updatedAt: args.now,
      source: "store",
    };
    if (existingPack) {
      await ctx.db.patch(existingPack._id, packPayload);
    } else {
      await ctx.db.insert("packs", {
        ...packPayload,
        createdAt: args.now,
      });
    }

    const existingVersion = await ctx.db
      .query("pack_versions")
      .withIndex("by_pack_version", (q) =>
        q.eq("packId", args.packId).eq("version", args.version),
      )
      .take(1);

    const versionPayload = {
      packId: args.packId,
      version: args.version,
      manifest: args.manifest,
      bundleStorageKey: args.bundleStorageKey,
      bundleHash: args.bundleHash,
      signature: args.signature,
      authorPublicKey: args.authorPublicKey,
      securityReview: args.securityReview,
      changedPaths: args.changedPaths,
      zones: args.zones,
      compatibilityNotes: args.compatibilityNotes,
      updatedAt: args.now,
      source: "store",
    };
    if (existingVersion[0]) {
      await ctx.db.patch(existingVersion[0]._id, versionPayload);
    } else {
      await ctx.db.insert("pack_versions", {
        ...versionPayload,
        createdAt: args.now,
      });
    }

    return { ok: true };
  },
});

export const recordInstallation = mutation({
  args: {
    installId: v.string(),
    packId: v.string(),
    version: v.string(),
    status: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    bundleHash: v.optional(v.string()),
    signature: v.optional(v.string()),
    authorPublicKey: v.optional(v.string()),
    changedPaths: v.optional(v.array(v.string())),
    zones: v.optional(v.array(v.string())),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("pack_installations")
      .withIndex("by_install", (q) => q.eq("installId", args.installId))
      .take(1);

    const payload = {
      installId: args.installId,
      packId: args.packId,
      version: args.version,
      status: args.status,
      deviceId: args.deviceId,
      changeSetId: args.changeSetId,
      bundleHash: args.bundleHash,
      signature: args.signature,
      authorPublicKey: args.authorPublicKey,
      changedPaths: args.changedPaths,
      zones: args.zones,
      conversationId: args.conversationId,
      updatedAt: now,
    };

    if (existing[0]) {
      await ctx.db.patch(existing[0]._id, payload);
      return await ctx.db.get(existing[0]._id);
    }

    const id = await ctx.db.insert("pack_installations", {
      ...payload,
      installedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const safeModeDisabled = mutation({
  args: {
    reason: v.string(),
    disabledAt: v.number(),
    packIds: v.array(v.string()),
    deviceId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.deviceId || args.packIds.length === 0) {
      return { ok: true, disabled: 0 };
    }
    let disabled = 0;
    for (const packId of args.packIds) {
      const records = await ctx.db
        .query("pack_installations")
        .withIndex("by_pack_device", (q) =>
          q.eq("packId", packId).eq("deviceId", args.deviceId),
        )
        .order("desc")
        .take(50);
      for (const record of records) {
        if (record.status !== "installed") {
          continue;
        }
        disabled += 1;
        await ctx.db.patch(record._id, {
          status: "disabled_safe_mode",
          updatedAt: args.disabledAt,
        });
      }
    }
    return { ok: true, disabled };
  },
});

export const listPacks = query({
  args: {},
  handler: async (ctx) => {
    const packs = await ctx.db
      .query("packs")
      .withIndex("by_updated")
      .order("desc")
      .take(200);
    return packs.map((pack) => {
      const { authorPublicKey, ...rest } = pack;
      return rest;
    });
  },
});

