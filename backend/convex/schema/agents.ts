import { defineTable } from "convex/server";
import { v } from "convex/values";

export const agentsSchema = {
  agents: defineTable({
    ownerId: v.optional(v.string()),
    id: v.string(),
    name: v.string(),
    description: v.string(),
    systemPrompt: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    maxAgentDepth: v.optional(v.number()),
    version: v.number(),
    source: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_id", ["ownerId", "id"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
};
