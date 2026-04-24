import { mutation, query, internalQuery, internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v, ConvexError } from "convex/values";
import { decryptSecret, encryptSecret } from "./secrets_crypto";
import { requireSensitiveUserId } from "../auth";
import {
  enforceMutationRateLimit,
  RATE_SENSITIVE,
} from "../lib/rate_limits";
import { optionalJsonValueValidator, requireBoundedString } from "../shared_validators";

const MAX_SECRET_PLAINTEXT_CHARS = 2000;
const SECRET_NOT_FOUND_ERROR = {
  code: "NOT_FOUND",
  message: "Secret not found or access denied",
} as const;

const requireOwnedSecret = async (
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  ownerId: string,
  secretId: Id<"secrets">,
) => {
  const record = await ctx.db.get(secretId);
  if (!record || record.ownerId !== ownerId) {
    throw new ConvexError(SECRET_NOT_FOUND_ERROR);
  }
  return record;
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
    requireBoundedString(args.provider, "provider", 100);
    requireBoundedString(args.label, "label", 100);
    requireBoundedString(args.plaintext, "plaintext", MAX_SECRET_PLAINTEXT_CHARS);

    const ownerId = await requireSensitiveUserId(ctx);
    // Each call runs WebCrypto AES + a row insert. Cap so a hijacked
    // session can't churn secret rows.
    await enforceMutationRateLimit(
      ctx,
      "secrets_create",
      ownerId,
      RATE_SENSITIVE,
      "Too many secret writes. Please wait a minute and try again.",
    );
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
  handler: async (ctx, args) => {
    const now = Date.now();
    const encryptedPayload = await encryptSecret(args.plaintext);
    const encryptedValue = JSON.stringify(encryptedPayload);

    const existing = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_provider_and_updatedAt", (q) =>
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
      provider: v.string(),
      label: v.string(),
      status: v.string(),
      metadata: optionalJsonValueValidator,
      createdAt: v.number(),
      updatedAt: v.number(),
      lastUsedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireSensitiveUserId(ctx);
    const records = args.provider
      ? await ctx.db
          .query("secrets")
          .withIndex("by_ownerId_and_provider_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId).eq("provider", args.provider as string),
          )
          .order("desc")
          .take(200)
      : await ctx.db
          .query("secrets")
          .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
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
  handler: async (ctx, args) => {
    requireBoundedString(args.plaintext, "plaintext", MAX_SECRET_PLAINTEXT_CHARS);
    if (args.label !== undefined) {
      requireBoundedString(args.label, "label", 100);
    }

    const ownerId = await requireSensitiveUserId(ctx);
    const record = await requireOwnedSecret(ctx, ownerId, args.secretId);

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
    const ownerId = await requireSensitiveUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "secrets_delete",
      ownerId,
      RATE_SENSITIVE,
      "Too many secret deletions. Please wait a minute and try again.",
    );
    await requireOwnedSecret(ctx, ownerId, args.secretId);
    await ctx.db.delete(args.secretId);
    return null;
  },
});

export const listSecretsInternal = internalQuery({
  args: {
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", args.ownerId))
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
  handler: async (ctx, args) => {
    const record = await requireOwnedSecret(ctx, args.ownerId, args.secretId);
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
  handler: async (ctx, args) => {
    await requireOwnedSecret(ctx, args.ownerId, args.secretId);
    await ctx.db.patch(args.secretId, { lastUsedAt: Date.now() });
    return null;
  },
});

export const getDecryptedLlmKey = internalQuery({
  args: {
    ownerId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_provider_and_updatedAt", (q) =>
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
