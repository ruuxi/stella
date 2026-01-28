import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { decryptSecret, encryptSecret } from "./secrets_crypto";
import type { Id } from "./_generated/dataModel";

const secretPublicFields = {
  provider: v.string(),
  label: v.string(),
  status: v.string(),
  metadata: v.optional(v.any()),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastUsedAt: v.optional(v.number()),
};

export const createSecret = mutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    label: v.string(),
    plaintext: v.string(),
    metadata: v.optional(v.any()),
  },
  returns: v.object({
    secretId: v.id("secrets"),
    provider: v.string(),
    label: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const encryptedPayload = await encryptSecret(args.plaintext);
    const encryptedValue = JSON.stringify(encryptedPayload);

    const secretId = await ctx.db.insert("secrets", {
      ownerId: args.ownerId,
      provider: args.provider,
      label: args.label,
      encryptedValue,
      keyVersion: encryptedPayload.keyVersion,
      status: "active",
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });

    return {
      secretId,
      provider: args.provider,
      label: args.label,
      createdAt: now,
      updatedAt: now,
    };
  },
});

export const listSecrets = query({
  args: {
    ownerId: v.string(),
    provider: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      _id: v.id("secrets"),
      ...secretPublicFields,
    }),
  ),
  handler: async (ctx, args) => {
    const records = args.provider
      ? await ctx.db
          .query("secrets")
          .withIndex("by_owner_and_provider_and_updated", (q) =>
            q.eq("ownerId", args.ownerId).eq("provider", args.provider as string),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("secrets")
          .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", args.ownerId))
          .order("desc")
          .take(200);

    return records.map((record) => ({
      _id: record._id,
      provider: record.provider,
      label: record.label,
      status: record.status,
      metadata: record.metadata ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt ?? undefined,
    }));
  },
});

export const updateSecret = mutation({
  args: {
    ownerId: v.string(),
    secretId: v.id("secrets"),
    plaintext: v.string(),
    label: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  returns: v.object({
    secretId: v.id("secrets"),
    provider: v.string(),
    label: v.string(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== args.ownerId) {
      throw new Error("Secret not found or access denied.");
    }

    const now = Date.now();
    const encryptedPayload = await encryptSecret(args.plaintext);
    const encryptedValue = JSON.stringify(encryptedPayload);

    const nextLabel = args.label?.trim() ? args.label.trim() : record.label;
    await ctx.db.patch(args.secretId, {
      label: nextLabel,
      encryptedValue,
      keyVersion: encryptedPayload.keyVersion,
      metadata: args.metadata ?? record.metadata,
      updatedAt: now,
    });

    return {
      secretId: args.secretId,
      provider: record.provider,
      label: nextLabel,
      updatedAt: now,
    };
  },
});

export const deleteSecret = mutation({
  args: {
    ownerId: v.string(),
    secretId: v.id("secrets"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== args.ownerId) {
      throw new Error("Secret not found or access denied.");
    }
    await ctx.db.delete(args.secretId);
    return null;
  },
});

export const getSecretHandle = query({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.array(
    v.object({
      secretId: v.id("secrets"),
      label: v.string(),
      provider: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("secrets")
      .withIndex("by_owner_and_provider_and_updated", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .order("desc")
      .take(50);

    return records.map((record) => ({
      secretId: record._id,
      label: record.label,
      provider: record.provider,
    }));
  },
});

export const getSecretForTool = internalQuery({
  args: {
    ownerId: v.string(),
    secretId: v.id("secrets"),
  },
  returns: v.object({
    secretId: v.id("secrets"),
    provider: v.string(),
    label: v.string(),
    plaintext: v.string(),
    status: v.string(),
    metadata: v.optional(v.any()),
  }),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== args.ownerId) {
      throw new Error("Secret not found or access denied.");
    }
    const plaintext = await decryptSecret(record.encryptedValue);
    return {
      secretId: record._id,
      provider: record.provider,
      label: record.label,
      plaintext,
      status: record.status,
      metadata: record.metadata ?? undefined,
    };
  },
});

export const touchSecretUsage = internalMutation({
  args: {
    ownerId: v.string(),
    secretId: v.id("secrets"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== args.ownerId) {
      throw new Error("Secret not found or access denied.");
    }
    await ctx.db.patch(args.secretId, { lastUsedAt: Date.now() });
    return null;
  },
});

export const auditSecretAccess = internalMutation({
  args: {
    ownerId: v.string(),
    secretId: v.id("secrets"),
    toolName: v.string(),
    requestId: v.string(),
    status: v.string(),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("secret_access_audit", {
      ownerId: args.ownerId,
      secretId: args.secretId,
      toolName: args.toolName,
      requestId: args.requestId,
      status: args.status,
      reason: args.reason,
      createdAt: Date.now(),
    });
    return null;
  },
});
