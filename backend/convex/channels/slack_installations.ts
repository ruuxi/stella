import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import {
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecretSerialized,
} from "../data/secrets_crypto";

const slackInstallationWithTokenValidator = v.object({
  _id: v.id("slack_installations"),
  _creationTime: v.number(),
  teamId: v.string(),
  teamName: v.optional(v.string()),
  botToken: v.string(),
  botTokenKeyVersion: v.optional(v.number()),
  botUserId: v.optional(v.string()),
  scope: v.optional(v.string()),
  installedBy: v.optional(v.string()),
  installedAt: v.number(),
  updatedAt: v.number(),
});

export const getByTeamId = internalQuery({
  args: { teamId: v.string() },
  returns: v.union(slackInstallationWithTokenValidator, v.null()),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("slack_installations")
      .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
      .first();
    if (!record) {
      return null;
    }

    const botToken = await decryptSecretIfNeeded(record.botToken);

    return {
      _id: record._id,
      _creationTime: record._creationTime,
      teamId: record.teamId,
      teamName: record.teamName,
      botToken,
      botTokenKeyVersion: record.botTokenKeyVersion,
      botUserId: record.botUserId,
      scope: record.scope,
      installedBy: record.installedBy,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    };
  },
});

export const upsert = internalMutation({
  args: {
    teamId: v.string(),
    teamName: v.optional(v.string()),
    botToken: v.string(),
    botUserId: v.optional(v.string()),
    scope: v.optional(v.string()),
    installedBy: v.optional(v.string()),
  },
  returns: v.id("slack_installations"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const encrypted = await encryptSecret(args.botToken);
    const serialized = JSON.stringify(encrypted);
    const existing = await ctx.db
      .query("slack_installations")
      .withIndex("by_teamId", (q) => q.eq("teamId", args.teamId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        botToken: serialized,
        botTokenKeyVersion: encrypted.keyVersion,
        teamName: args.teamName,
        botUserId: args.botUserId,
        scope: args.scope,
        installedBy: args.installedBy,
        updatedAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("slack_installations", {
      teamId: args.teamId,
      teamName: args.teamName,
      botToken: serialized,
      botTokenKeyVersion: encrypted.keyVersion,
      botUserId: args.botUserId,
      scope: args.scope,
      installedBy: args.installedBy,
      installedAt: now,
      updatedAt: now,
    });
  },
});

export const backfillPlaintextTokens = internalMutation({
  args: {},
  returns: v.object({ migrated: v.number() }),
  handler: async (ctx) => {
    const records = await ctx.db.query("slack_installations").collect();
    let migrated = 0;
    for (const record of records) {
      if (isEncryptedSecretSerialized(record.botToken)) {
        continue;
      }
      const encrypted = await encryptSecret(record.botToken);
      await ctx.db.patch(record._id, {
        botToken: JSON.stringify(encrypted),
        botTokenKeyVersion: encrypted.keyVersion,
        updatedAt: Date.now(),
      });
      migrated += 1;
    }
    return { migrated };
  },
});
