import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_default", ["ownerId", "isDefault"])
    .index("by_owner_updated", ["ownerId", "updatedAt"]),
  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: v.string(),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: v.any(),
  })
    .index("by_conversation", ["conversationId", "timestamp"])
    .index("by_conversation_type", ["conversationId", "type", "timestamp"])
    .index("by_target_device", ["targetDeviceId", "timestamp"])
    .index("by_request", ["requestId"]),
  attachments: defineTable({
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.string(),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_device", ["deviceId"]),
  agents: defineTable({
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
    .index("by_agent_key", ["id"])
    .index("by_updated", ["updatedAt"]),
  skills: defineTable({
    id: v.string(),
    name: v.string(),
    description: v.string(),
    markdown: v.string(),
    agentTypes: v.array(v.string()),
    toolsAllowlist: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    version: v.number(),
    source: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_skill_key", ["id"])
    .index("by_enabled", ["enabled"])
    .index("by_updated", ["updatedAt"]),
  plugins: defineTable({
    id: v.string(),
    name: v.string(),
    version: v.string(),
    description: v.optional(v.string()),
    source: v.string(),
    updatedAt: v.number(),
  })
    .index("by_plugin_key", ["id"])
    .index("by_updated", ["updatedAt"]),
  plugin_tools: defineTable({
    id: v.string(),
    pluginId: v.string(),
    name: v.string(),
    description: v.string(),
    inputSchema: v.any(),
    source: v.string(),
    updatedAt: v.number(),
  })
    .index("by_tool_key", ["id"])
    .index("by_name", ["name"])
    .index("by_plugin", ["pluginId", "updatedAt"]),
  tasks: defineTable({
    conversationId: v.id("conversations"),
    parentTaskId: v.optional(v.id("tasks")),
    description: v.string(),
    prompt: v.string(),
    agentType: v.string(),
    status: v.string(),
    taskDepth: v.number(),
    model: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId", "createdAt"])
    .index("by_status", ["status", "updatedAt"])
    .index("by_parent", ["parentTaskId", "createdAt"]),
});
