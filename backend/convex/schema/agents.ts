import { defineTable } from "convex/server";
import { v } from "convex/values";
import { secretMountsValidator } from "../shared_validators";

export const agentsSchema = {
  agents: defineTable({
    ownerId: v.optional(v.string()),
    id: v.string(),
    name: v.string(),
    description: v.string(),
    systemPrompt: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    defaultSkills: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    maxTaskDepth: v.optional(v.number()),
    version: v.number(),
    source: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_id", ["ownerId", "id"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  commands: defineTable({
    commandId: v.string(),
    name: v.string(),
    description: v.string(),
    pluginName: v.string(),
    content: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_commandId", ["commandId"])
    .index("by_enabled_and_updatedAt", ["enabled", "updatedAt"]),

  skills: defineTable({
    ownerId: v.optional(v.string()),
    id: v.string(),
    name: v.string(),
    description: v.string(),
    markdown: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    execution: v.optional(v.string()),
    requiresSecrets: v.optional(v.array(v.string())),
    publicIntegration: v.optional(v.boolean()),
    secretMounts: secretMountsValidator,
    version: v.number(),
    source: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_id", ["ownerId", "id"])
    .index("by_ownerId_and_enabled", ["ownerId", "enabled"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

};
