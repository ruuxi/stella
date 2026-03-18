import { defineTable } from "convex/server";
import { v } from "convex/values";

export const telemetrySchema = {
  persist_chunks: defineTable({
    runId: v.string(),
    chunkKey: v.string(),
    chunkIndex: v.number(),
    isFinal: v.boolean(),
    events: v.array(v.object({
      type: v.string(),
      toolCallId: v.optional(v.string()),
      toolName: v.optional(v.string()),
      argsPreview: v.optional(v.string()),
      resultPreview: v.optional(v.string()),
      errorText: v.optional(v.string()),
      durationMs: v.optional(v.number()),
      timestamp: v.number(),
    })),
    assistantText: v.optional(v.string()),
    threadMessages: v.optional(v.array(v.object({
      role: v.string(),
      content: v.string(),
      toolCallId: v.optional(v.string()),
    }))),
    usage: v.optional(v.object({
      inputTokens: v.optional(v.number()),
      outputTokens: v.optional(v.number()),
    })),
    conversationId: v.id("conversations"),
    agentType: v.string(),
    ownerId: v.string(),
    createdAt: v.number(),
  })
    .index("by_chunkKey", ["chunkKey"])
    .index("by_runId_and_chunkIndex", ["runId", "chunkIndex"])
    .index("by_runId_and_isFinal", ["runId", "isFinal"])
    .index("by_ownerId", ["ownerId"]),

  usage_logs: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    agentType: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteInputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    costMicroCents: v.optional(v.number()),
    billingPlan: v.optional(v.union(
      v.literal("free"),
      v.literal("go"),
      v.literal("pro"),
      v.literal("plus"),
      v.literal("ultra"),
    )),
    durationMs: v.number(),
    success: v.boolean(),
    fallbackUsed: v.optional(v.boolean()),
    toolCalls: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"]),
};
