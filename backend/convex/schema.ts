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
    filePath: v.optional(v.string()),
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
  changesets: defineTable({
    changeSetId: v.string(),
    scope: v.string(),
    agentType: v.string(),
    status: v.string(),
    reason: v.optional(v.string()),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    baselineId: v.optional(v.string()),
    gitHeadAtStart: v.optional(v.string()),
    gitHeadAtEnd: v.optional(v.string()),
    diffPatch: v.optional(v.string()),
    diffPatchTruncated: v.optional(v.boolean()),
    changedFiles: v.any(),
    instructionInvariants: v.any(),
    instructionNotes: v.any(),
    blockReasons: v.any(),
    guardFailures: v.any(),
    validations: v.any(),
    validationSummary: v.any(),
    rollbackApplied: v.optional(v.boolean()),
    rollbackReason: v.optional(v.string()),
    lastError: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    deviceId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_change_set", ["changeSetId"])
    .index("by_updated", ["updatedAt"])
    .index("by_conversation", ["conversationId", "updatedAt"]),
  safe_mode_events: defineTable({
    bootId: v.string(),
    status: v.string(),
    safeModeApplied: v.boolean(),
    smokePassed: v.boolean(),
    reason: v.optional(v.string()),
    smokeFailures: v.optional(v.array(v.string())),
    deviceId: v.optional(v.string()),
    checkedAt: v.number(),
  })
    .index("by_boot", ["bootId"])
    .index("by_checked", ["checkedAt"]),
  packs: defineTable({
    packId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    authorPublicKey: v.string(),
    latestVersion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    source: v.string(),
  })
    .index("by_pack", ["packId"])
    .index("by_updated", ["updatedAt"]),
  pack_versions: defineTable({
    packId: v.string(),
    version: v.string(),
    manifest: v.any(),
    bundleStorageKey: v.id("_storage"),
    bundleHash: v.string(),
    signature: v.string(),
    authorPublicKey: v.string(),
    securityReview: v.any(),
    changedPaths: v.array(v.string()),
    zones: v.array(v.string()),
    compatibilityNotes: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    source: v.string(),
  })
    .index("by_pack_version", ["packId", "version"])
    .index("by_pack_created", ["packId", "createdAt"])
    .index("by_updated", ["updatedAt"]),
  pack_installations: defineTable({
    installId: v.string(),
    packId: v.string(),
    version: v.string(),
    status: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    bundleHash: v.optional(v.string()),
    signature: v.optional(v.string()),
    authorPublicKey: v.optional(v.string()),
    changedPaths: v.optional(v.array(v.string())),
    zones: v.optional(v.array(v.string())),
    conversationId: v.optional(v.id("conversations")),
    installedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_install", ["installId"])
    .index("by_pack_device", ["packId", "deviceId", "updatedAt"])
    .index("by_device", ["deviceId", "updatedAt"]),
  update_channels: defineTable({
    channelId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    latestReleaseId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_channel", ["channelId"])
    .index("by_updated", ["updatedAt"]),
  update_releases: defineTable({
    releaseId: v.string(),
    channelId: v.string(),
    version: v.string(),
    baseGitHead: v.optional(v.string()),
    bundleStorageKey: v.id("_storage"),
    bundleHash: v.string(),
    signature: v.string(),
    authorPublicKey: v.string(),
    notes: v.optional(v.string()),
    manifest: v.any(),
    changedPaths: v.optional(v.array(v.string())),
    zones: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
    source: v.string(),
  })
    .index("by_release", ["releaseId"])
    .index("by_channel_created", ["channelId", "createdAt"])
    .index("by_channel_version", ["channelId", "version"]),
  update_applied: defineTable({
    releaseId: v.string(),
    channelId: v.string(),
    version: v.string(),
    deviceId: v.string(),
    changeSetId: v.optional(v.string()),
    conversationId: v.optional(v.id("conversations")),
    conflicts: v.optional(v.number()),
    status: v.string(),
    appliedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_release_device", ["releaseId", "deviceId"])
    .index("by_device_updated", ["deviceId", "updatedAt"]),
});
