import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  jsonObjectValidator,
  jsonSchemaValidator,
  jsonValueValidator,
  optionalJsonValueValidator,
  secretMountsValidator,
} from "./shared_validators";

const bridgeAuthStateValidator = v.optional(
  v.object({
    qrCode: v.optional(v.string()),
    linkUri: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    phoneNumber: v.optional(v.string()),
    externalUserId: v.optional(v.string()),
    displayName: v.optional(v.string()),
    jid: v.optional(v.string()),
    reason: v.optional(v.string()),
  }),
);

const cronScheduleValidator = v.union(
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

const cronPayloadValidator = v.union(
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
    includeHistory: v.optional(v.boolean()),
  }),
);

export default defineSchema({
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    tokenCount: v.optional(v.number()),
    lastIngestedAt: v.optional(v.number()),
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
    payload: jsonValueValidator,
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
    secretMounts: secretMountsValidator,
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
    metadata: optionalJsonValueValidator,
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
    config: jsonObjectValidator,
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
  cloud_devices: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
    lastActiveAt: v.number(),
    setupComplete: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_sprite_name", ["spriteName"]),
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
    inputSchema: jsonSchemaValidator,
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
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_key", ["key"]),
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
  memories: defineTable({
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    category: v.string(),
    subcategory: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
    accessedAt: v.number(),
    createdAt: v.number(),
    decay: v.number(),
  })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["ownerId", "category"],
    })
    .index("by_owner_category", ["ownerId", "category", "subcategory"])
    .index("by_decay", ["decay", "accessedAt"]),
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
    lastRunAtMs: v.optional(v.number()),
    nextRunAtMs: v.number(),
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastSentText: v.optional(v.string()),
    lastSentAtMs: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_conversation", ["ownerId", "conversationId"])
    .index("by_next_run", ["nextRunAtMs", "ownerId"])
    .index("by_owner_updated", ["ownerId", "updatedAt"]),
  channel_connections: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    displayName: v.optional(v.string()),
    linkedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider_external", ["provider", "externalUserId"])
    .index("by_owner_provider", ["ownerId", "provider"])
    .index("by_owner_provider_external", ["ownerId", "provider", "externalUserId"]),
  bridge_sessions: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.string(),
    status: v.string(),
    webhookSecret: v.string(),
    authState: bridgeAuthStateValidator,
    errorMessage: v.optional(v.string()),
    lastHeartbeatAt: v.optional(v.number()),
    lastMessageAtMs: v.optional(v.number()),
    nextWakeAtMs: v.optional(v.number()),
    wakeIntervalMs: v.optional(v.number()),
    wakeTier: v.optional(v.string()),
    consecutiveEmptyWakes: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_provider", ["ownerId", "provider"])
    .index("by_sprite", ["spriteName", "provider"])
    .index("by_next_wake", ["nextWakeAtMs"]),
  store_packages: defineTable({
    packageId: v.string(),
    name: v.string(),
    author: v.string(),
    description: v.string(),
    implementation: v.optional(v.string()),
    type: v.union(
      v.literal("skill"),
      v.literal("canvas"),
      v.literal("plugin"),
      v.literal("theme"),
      v.literal("mod"),
    ),
    modPayload: v.optional(jsonValueValidator),
    version: v.string(),
    tags: v.array(v.string()),
    downloads: v.number(),
    rating: v.optional(v.number()),
    icon: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    readme: v.optional(v.string()),
    searchText: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_package_id", ["packageId"])
    .index("by_type", ["type", "updatedAt"])
    .index("by_downloads", ["downloads"])
    .searchIndex("search_packages", {
      searchField: "searchText",
      filterFields: ["type"],
    }),
  store_installs: defineTable({
    ownerId: v.string(),
    packageId: v.string(),
    installedVersion: v.string(),
    installedAt: v.number(),
  })
    .index("by_owner", ["ownerId", "installedAt"])
    .index("by_owner_package", ["ownerId", "packageId"]),
  canvas_states: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_owner_conversation", ["ownerId", "conversationId"])
    .index("by_owner_updated", ["ownerId", "updatedAt"]),
  self_mod_features: defineTable({
    featureId: v.string(),
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
    batchCount: v.number(),
    files: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_updated", ["ownerId", "updatedAt"])
    .index("by_conversation", ["conversationId", "updatedAt"])
    .index("by_feature_id", ["featureId"]),
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
    runningAtMs: v.optional(v.number()),
    lastRunAtMs: v.optional(v.number()),
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastDurationMs: v.optional(v.number()),
    lastOutputPreview: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_updated", ["ownerId", "updatedAt"])
    .index("by_next_run", ["nextRunAtMs", "ownerId"]),
});
