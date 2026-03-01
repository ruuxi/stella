import { defineTable } from "convex/server";
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
    kind: v.literal("systemEvent"),
    text: v.string(),
    agentType: v.optional(v.string()),
    deliver: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal("agentTurn"),
    message: v.string(),
    agentType: v.optional(v.string()),
    deliver: v.optional(v.boolean()),
  }),
);

export const schedulingSchema = {
  heartbeat_configs: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    enabled: v.boolean(),
    intervalMs: v.number(),
    prompt: v.optional(v.string()),
    checklist: v.optional(v.string()),
    ackMaxChars: v.optional(v.number()),
    deliver: v.optional(v.boolean()),
    agentType: v.optional(v.string()),
    activeHours: v.optional(
      v.object({
        start: v.string(),
        end: v.string(),
        timezone: v.optional(v.string()),
      }),
    ),
    targetDeviceId: v.optional(v.string()),
    runningAtMs: v.optional(v.number()),
    lastRunAtMs: v.optional(v.number()),
    nextRunAtMs: v.number(),
    scheduledRunId: v.optional(v.id("_scheduled_functions")),
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastSentText: v.optional(v.string()),
    lastSentAtMs: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_conversationId", ["ownerId", "conversationId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  cron_jobs: defineTable({
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    name: v.string(),
    description: v.optional(v.string()),
    enabled: v.boolean(),
    schedule: cronScheduleValidator,
    sessionTarget: v.string(),
    payload: cronPayloadValidator,
    deleteAfterRun: v.optional(v.boolean()),
    nextRunAtMs: v.number(),
    scheduledRunId: v.optional(v.id("_scheduled_functions")),
    runningAtMs: v.optional(v.number()),
    lastRunAtMs: v.optional(v.number()),
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastDurationMs: v.optional(v.number()),
    lastOutputPreview: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
};
