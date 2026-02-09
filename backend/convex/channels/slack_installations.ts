import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

export const getByTeamId = internalQuery({
  args: { teamId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("slack_installations"),
      _creationTime: v.number(),
      teamId: v.string(),
      teamName: v.optional(v.string()),
      botToken: v.string(),
      botUserId: v.optional(v.string()),
      scope: v.optional(v.string()),
      installedBy: v.optional(v.string()),
      installedAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .first();
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
    const existing = await ctx.db
      .query("slack_installations")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        botToken: args.botToken,
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
      botToken: args.botToken,
      botUserId: args.botUserId,
      scope: args.scope,
      installedBy: args.installedBy,
      installedAt: now,
      updatedAt: now,
    });
  },
});
