import { v } from "convex/values";

export const cronScheduleValidator = v.union(
  v.object({
    kind: v.literal("at"),
    atMs: v.number(),
  }),
  v.object({
    kind: v.literal("every"),
    everyMs: v.number(),
    anchorMs: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("cron"),
    expr: v.string(),
    tz: v.optional(v.string()),
  }),
);

export const cronPayloadValidator = v.union(
  v.object({
    kind: v.literal("notify"),
    text: v.string(),
  }),
  v.object({
    kind: v.literal("script"),
    scriptPath: v.string(),
  }),
  v.object({
    kind: v.literal("agent"),
    prompt: v.string(),
    agentType: v.optional(v.string()),
  }),
);

export const schedulingSchema = {
  // Scheduling moved to the local runtime. Keep validators exported so any
  // transitional modules can reuse the same shapes without reintroducing
  // backend persistence tables.
};
