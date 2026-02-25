import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  jsonObjectValidator,
  jsonValueValidator,
  optionalJsonValueValidator,
  optionalChannelEnvelopeValidator,
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
  }),
);

export default defineSchema({
  conversations: defineTable({
    ownerId: v.string(),
    title: v.optional(v.string()),
    isDefault: v.boolean(),
    activeThreadId: v.optional(v.id("threads")),
    orchestratorReminderHash: v.optional(v.string()),
    orchestratorReminderThreadId: v.optional(v.id("threads")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_isDefault", ["ownerId", "isDefault"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
  events: defineTable({
    conversationId: v.id("conversations"),
    timestamp: v.number(),
    type: v.string(),
    deviceId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    targetDeviceId: v.optional(v.string()),
    payload: jsonValueValidator,
    channelEnvelope: optionalChannelEnvelopeValidator,
  })
    .index("by_conversationId_and_timestamp", ["conversationId", "timestamp"])
    .index("by_conversationId_and_type_and_timestamp", ["conversationId", "type", "timestamp"])
    .index("by_targetDeviceId_and_timestamp", ["targetDeviceId", "timestamp"])
    .index("by_requestId", ["requestId"]),
  attachments: defineTable({
    conversationId: v.id("conversations"),
    deviceId: v.string(),
    storageKey: v.string(),
    url: v.optional(v.string()),
    mimeType: v.string(),
    size: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversationId", ["conversationId"])
    .index("by_deviceId", ["deviceId"]),
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
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_provider_and_updatedAt", ["ownerId", "provider", "updatedAt"]),
  secret_access_audit: defineTable({
    ownerId: v.string(),
    secretId: v.id("secrets"),
    toolName: v.string(),
    requestId: v.string(),
    status: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_secretId_and_createdAt", ["secretId", "createdAt"]),
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
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_ownerId_and_provider", ["ownerId", "provider"]),
  remote_computers: defineTable({
    ownerId: v.string(),
    railwayServiceId: v.string(),
    domain: v.string(),
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_railwayServiceId", ["railwayServiceId"]),
  devices: defineTable({
    ownerId: v.string(),
    deviceId: v.string(),
    devicePublicKey: v.optional(v.string()),
    lastSignedAtMs: v.optional(v.number()),
    online: v.boolean(),
    lastSeenAt: v.number(),
    platform: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_deviceId", ["deviceId"])
    .index("by_online_and_lastSeenAt", ["online", "lastSeenAt"]),
  auth_session_policies: defineTable({
    ownerId: v.string(),
    sessionVersion: v.number(),
    minIssuedAtSec: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),
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
    .index("by_ownerId", ["ownerId"])
    .index("by_lastActiveAt", ["lastActiveAt"])
    .index("by_spriteName", ["spriteName"]),
  user_preferences: defineTable({
    ownerId: v.string(),
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_key", ["ownerId", "key"])
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
    commandId: v.optional(v.string()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    statusUpdates: v.optional(v.array(v.object({
      text: v.string(),
      timestamp: v.number(),
    }))),
    deliveryCompletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"])
    .index("by_conversationId_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    .index("by_parentTaskId_and_createdAt", ["parentTaskId", "createdAt"]),
  threads: defineTable({
    conversationId: v.id("conversations"),
    name: v.string(),
    status: v.string(),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    totalTokenEstimate: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
    resurfacedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
  })
    .index("by_conversationId_and_status_and_lastUsedAt", ["conversationId", "status", "lastUsedAt"])
    .index("by_conversationId_and_name", ["conversationId", "name"])
    .index("by_conversationId_and_lastUsedAt", ["conversationId", "lastUsedAt"])
    .index("by_status_and_lastUsedAt", ["status", "lastUsedAt"]),
  thread_messages: defineTable({
    threadId: v.id("threads"),
    ordinal: v.number(),
    role: v.string(),
    content: v.string(),
    toolCallId: v.optional(v.string()),
    tokenEstimate: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_threadId_and_ordinal", ["threadId", "ordinal"]),
  memories: defineTable({
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
    accessCount: v.number(),
    accessedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_accessedAt", ["ownerId", "accessedAt"])
    .index("by_accessedAt", ["accessedAt"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["ownerId"],
    }),
  event_embeddings: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    eventId: v.id("events"),
    type: v.union(v.literal("user_message"), v.literal("assistant_message")),
    content: v.string(),
    timestamp: v.number(),
    embedding: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_ownerId_and_timestamp", ["ownerId", "timestamp"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["ownerId", "conversationId", "type"],
    }),
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
    lastStatus: v.optional(v.string()),
    lastError: v.optional(v.string()),
    lastSentText: v.optional(v.string()),
    lastSentAtMs: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_conversationId", ["ownerId", "conversationId"])
    .index("by_nextRunAtMs_and_ownerId", ["nextRunAtMs", "ownerId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
  channel_connections: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    displayName: v.optional(v.string()),
    linkedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_provider_and_externalUserId", ["provider", "externalUserId"])
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
    .index("by_ownerId_and_provider_and_externalUserId", ["ownerId", "provider", "externalUserId"]),
  transient_channel_events: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    provider: v.string(),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    text: v.string(),
    batchKey: v.string(),
    runId: v.optional(v.string()),
    metadata: v.optional(jsonObjectValidator),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_batchKey", ["batchKey"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"]),
  slack_installations: defineTable({
    teamId: v.string(),
    teamName: v.optional(v.string()),
    botToken: v.string(),
    botTokenKeyVersion: v.optional(v.number()),
    botUserId: v.optional(v.string()),
    scope: v.optional(v.string()),
    installedBy: v.optional(v.string()),
    installedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_teamId", ["teamId"]),
  bridge_sessions: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    spriteName: v.optional(v.string()),
    mode: v.optional(v.string()),
    status: v.string(),
    webhookSecret: v.string(),
    webhookSecretKeyVersion: v.optional(v.number()),
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
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
    .index("by_spriteName_and_provider", ["spriteName", "provider"])
    .index("by_nextWakeAtMs", ["nextWakeAtMs"]),
  bridge_outbound: defineTable({
    sessionId: v.id("bridge_sessions"),
    ownerId: v.string(),
    provider: v.string(),
    externalUserId: v.string(),
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_sessionId_and_createdAt", ["sessionId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),
  store_packages: defineTable({
    packageId: v.string(),
    name: v.string(),
    author: v.string(),
    description: v.string(),
    implementation: v.optional(v.string()),
    type: v.union(
      v.literal("skill"),
      v.literal("canvas"),
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
    .index("by_packageId", ["packageId"])
    .index("by_type_and_updatedAt", ["type", "updatedAt"])
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
    .index("by_ownerId_and_installedAt", ["ownerId", "installedAt"])
    .index("by_ownerId_and_packageId", ["ownerId", "packageId"]),
  canvas_states: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_ownerId_and_conversationId", ["ownerId", "conversationId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
  dashboard_pages: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    pageId: v.string(),
    panelName: v.string(),
    title: v.string(),
    topic: v.string(),
    focus: v.string(),
    dataSources: v.array(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    order: v.number(),
    taskId: v.optional(v.id("tasks")),
    retryCount: v.number(),
    statusText: v.optional(v.string()),
    lastError: v.optional(v.string()),
    // Lease-based claiming for local vs server generation
    claimedBy: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_ownerId_and_order", ["ownerId", "order"])
    .index("by_ownerId_and_pageId", ["ownerId", "pageId"])
    .index("by_ownerId_and_status", ["ownerId", "status"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),
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
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_conversationId_and_updatedAt", ["conversationId", "updatedAt"])
    .index("by_featureId", ["featureId"]),
  linq_chats: defineTable({
    phoneNumber: v.string(),
    linqChatId: v.string(),
    createdAt: v.number(),
  })
    .index("by_phoneNumber", ["phoneNumber"]),
  proxy_tokens: defineTable({
    ownerId: v.string(),
    token: v.string(),
    agentType: v.string(),
    runId: v.string(),
    audience: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),
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
    .index("by_runId_and_isFinal", ["runId", "isFinal"]),
  usage_logs: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    agentType: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    durationMs: v.number(),
    success: v.boolean(),
    fallbackUsed: v.optional(v.boolean()),
    toolCalls: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_conversationId_and_createdAt", ["conversationId", "createdAt"]),
  anon_device_usage: defineTable({
    deviceId: v.string(),
    requestCount: v.number(),
    firstRequestAt: v.number(),
    lastRequestAt: v.number(),
  })
    .index("by_deviceId", ["deviceId"]),
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
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"])
    .index("by_nextRunAtMs_and_ownerId", ["nextRunAtMs", "ownerId"]),
});
