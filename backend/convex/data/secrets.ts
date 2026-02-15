import { mutation, query, internalQuery, internalMutation } from "../_generated/server";
import { v, ConvexError } from "convex/values";
import { decryptSecret, encryptSecret } from "./secrets_crypto";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireUserId } from "../auth";
import { optionalJsonValueValidator } from "../shared_validators";

const secretPublicFields = {
  provider: v.string(),
  label: v.string(),
  status: v.string(),
  metadata: optionalJsonValueValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  lastUsedAt: v.optional(v.number()),
};

const SECRET_READ_ALLOWED_TOOLS = new Set(["SkillBash"]);
const SECRET_READ_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

const assertSecretReadToolContext = async (
  ctx: QueryCtx,
  ownerId: string,
  args: { requestId: string; toolName: string; deviceId?: string },
) => {
  if (!SECRET_READ_ALLOWED_TOOLS.has(args.toolName)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: `Secret plaintext access is not allowed for tool "${args.toolName}".`,
    });
  }

  const now = Date.now();
  const events = await ctx.db
    .query("events")
    .withIndex("by_request", (q) => q.eq("requestId", args.requestId))
    .order("desc")
    .take(20);

  const requestEvent =
    events.find((event) => {
      if (event.type !== "tool_request") {
        return false;
      }
      if (now - event.timestamp > SECRET_READ_REQUEST_MAX_AGE_MS) {
        return false;
      }
      if (args.deviceId && event.targetDeviceId !== args.deviceId) {
        return false;
      }
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as { toolName?: string })
          : {};
      return payload.toolName === args.toolName;
    }) ?? null;

  if (!requestEvent) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Secret plaintext access requires an active matching tool request.",
    });
  }

  const conversation = await ctx.db.get(requestEvent.conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Secret plaintext access denied for this conversation context.",
    });
  }
};

export const createSecret = mutation({
  args: {
    provider: v.string(),
    label: v.string(),
    plaintext: v.string(),
    metadata: optionalJsonValueValidator,
  },
  returns: v.object({
    secretId: v.id("secrets"),
    provider: v.string(),
    label: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const encryptedPayload = await encryptSecret(args.plaintext);
    const encryptedValue = JSON.stringify(encryptedPayload);

    const secretId = await ctx.db.insert("secrets", {
      ownerId,
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

export const upsertManagedSecretForOwner = internalMutation({
  args: {
    ownerId: v.string(),
    provider: v.string(),
    label: v.string(),
    plaintext: v.string(),
    metadata: optionalJsonValueValidator,
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

    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_owner_and_provider_and_updated", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .order("desc")
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        label: args.label,
        encryptedValue,
        keyVersion: encryptedPayload.keyVersion,
        status: "active",
        metadata: args.metadata ?? existing.metadata,
        updatedAt: now,
      });
      return {
        secretId: existing._id,
        provider: args.provider,
        label: args.label,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    }

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
    provider: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      _id: v.id("secrets"),
      ...secretPublicFields,
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const records = args.provider
      ? await ctx.db
          .query("secrets")
          .withIndex("by_owner_and_provider_and_updated", (q) =>
            q.eq("ownerId", ownerId).eq("provider", args.provider as string),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("secrets")
          .withIndex("by_owner_and_updated", (q) => q.eq("ownerId", ownerId))
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

export const updateSecret = internalMutation({
  args: {
    secretId: v.id("secrets"),
    plaintext: v.string(),
    label: v.optional(v.string()),
    metadata: optionalJsonValueValidator,
  },
  returns: v.object({
    secretId: v.id("secrets"),
    provider: v.string(),
    label: v.string(),
    updatedAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Secret not found or access denied" });
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
    secretId: v.id("secrets"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Secret not found or access denied" });
    }
    await ctx.db.delete(args.secretId);
    return null;
  },
});

export const getSecretHandle = internalQuery({
  args: {
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
    const ownerId = await requireUserId(ctx);
    const records = await ctx.db
      .query("secrets")
      .withIndex("by_owner_and_provider_and_updated", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
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

export const getSecretValueForProvider = query({
  args: {
    provider: v.string(),
    requestId: v.string(),
    toolName: v.string(),
    deviceId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      secretId: v.id("secrets"),
      provider: v.string(),
      label: v.string(),
      plaintext: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await assertSecretReadToolContext(ctx, ownerId, {
      requestId: args.requestId,
      toolName: args.toolName,
      deviceId: args.deviceId,
    });
    const record = await ctx.db
      .query("secrets")
      .withIndex("by_owner_and_provider_and_updated", (q) =>
        q.eq("ownerId", ownerId).eq("provider", args.provider),
      )
      .order("desc")
      .first();
    if (!record || record.ownerId !== ownerId) {
      return null;
    }
    const plaintext = await decryptSecret(record.encryptedValue);
    return {
      secretId: record._id,
      provider: record.provider,
      label: record.label,
      plaintext,
    };
  },
});

export const getSecretValueById = query({
  args: {
    secretId: v.id("secrets"),
    requestId: v.string(),
    toolName: v.string(),
    deviceId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      secretId: v.id("secrets"),
      provider: v.string(),
      label: v.string(),
      plaintext: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await assertSecretReadToolContext(ctx, ownerId, {
      requestId: args.requestId,
      toolName: args.toolName,
      deviceId: args.deviceId,
    });
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== ownerId) {
      return null;
    }
    const plaintext = await decryptSecret(record.encryptedValue);
    return {
      secretId: record._id,
      provider: record.provider,
      label: record.label,
      plaintext,
    };
  },
});

export const listSecretsInternal = internalQuery({
  args: {
    ownerId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id("secrets"),
      ...secretPublicFields,
    }),
  ),
  handler: async (ctx, args) => {
    const records = await ctx.db
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
    metadata: optionalJsonValueValidator,
  }),
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.secretId);
    if (!record || record.ownerId !== args.ownerId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Secret not found or access denied" });
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
      throw new ConvexError({ code: "NOT_FOUND", message: "Secret not found or access denied" });
    }
    await ctx.db.patch(args.secretId, { lastUsedAt: Date.now() });
    return null;
  },
});

export const getDecryptedLlmKey = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("secrets")
      .withIndex("by_owner_and_provider_and_updated", (q) =>
        q.eq("ownerId", args.ownerId).eq("provider", args.provider),
      )
      .order("desc")
      .first();
    if (!record || record.status !== "active") {
      return null;
    }
    return await decryptSecret(record.encryptedValue);
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
