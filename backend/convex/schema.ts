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
    execution: v.optional(v.string()),
    requiresSecrets: v.optional(v.array(v.string())),
    publicIntegration: v.optional(v.boolean()),
    secretMounts: v.optional(v.any()),
    version: v.number(),
    source: v.string(),
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_skill_key", ["id"])
    .index("by_enabled", ["enabled"])
    .index("by_updated", ["updatedAt"]),
  secrets: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    label: v.string(),
    encryptedValue: v.string(),
    keyVersion: v.number(),
    status: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_owner_and_updated", ["ownerId", "updatedAt"])
    .index("by_owner_and_provider_and_updated", ["ownerId", "provider", "updatedAt"]),
  secret_access_audit: defineTable({
    ownerId: v.string(),
    secretId: v.id("secrets"),
    toolName: v.string(),
    requestId: v.string(),
    status: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_owner_and_created", ["ownerId", "createdAt"])
    .index("by_secret_and_created", ["secretId", "createdAt"]),
  integrations_public: defineTable({
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
    updatedAt: v.number(),
  }).index("by_integration_id", ["id"]),
  user_integrations: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    mode: v.string(),
    externalId: v.optional(v.string()),
    config: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_updated", ["ownerId", "updatedAt"])
    .index("by_owner_and_provider", ["ownerId", "provider"]),
  remote_computers: defineTable({
    ownerId: v.string(),
    railwayServiceId: v.string(),
    domain: v.string(),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_updated", ["ownerId", "updatedAt"])
    .index("by_railway_service", ["railwayServiceId"]),
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
  user_preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  })
    .index("by_owner_key", ["ownerId", "key"]),
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
