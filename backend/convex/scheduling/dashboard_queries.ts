import { query } from "../_generated/server";
import { v } from "convex/values";
import { requireUserId } from "../auth";

export const listCronJobs = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("cron_jobs"),
      name: v.string(),
      description: v.optional(v.string()),
      enabled: v.optional(v.boolean()),
      nextRunAtMs: v.optional(v.number()),
      lastRunAtMs: v.optional(v.number()),
      lastStatus: v.optional(v.string()),
      lastOutputPreview: v.optional(v.string()),
      lastDurationMs: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const jobs = await ctx.db
      .query("cron_jobs")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(50);
    return jobs.map((job) => ({
      _id: job._id,
      name: job.name,
      description: job.description,
      enabled: job.enabled,
      nextRunAtMs: job.nextRunAtMs,
      lastRunAtMs: job.lastRunAtMs,
      lastStatus: job.lastStatus,
      lastOutputPreview: job.lastOutputPreview,
      lastDurationMs: job.lastDurationMs,
    }));
  },
});

export const listHeartbeats = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("heartbeat_configs"),
      enabled: v.optional(v.boolean()),
      intervalMs: v.optional(v.number()),
      prompt: v.optional(v.string()),
      nextRunAtMs: v.optional(v.number()),
      lastRunAtMs: v.optional(v.number()),
      lastStatus: v.optional(v.string()),
      lastSentText: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const configs = await ctx.db
      .query("heartbeat_configs")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(50);
    return configs.map((config) => ({
      _id: config._id,
      enabled: config.enabled,
      intervalMs: config.intervalMs,
      prompt: config.prompt,
      nextRunAtMs: config.nextRunAtMs,
      lastRunAtMs: config.lastRunAtMs,
      lastStatus: config.lastStatus,
      lastSentText: config.lastSentText,
    }));
  },
});
