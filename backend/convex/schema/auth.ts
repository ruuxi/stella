import { defineTable } from "convex/server";
import { v } from "convex/values";
import { optionalJsonValueValidator } from "../shared_validators";

export const authSchema = {
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

  auth_session_policies: defineTable({
    ownerId: v.string(),
    sessionVersion: v.number(),
    minIssuedAtSec: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_ownerId", ["ownerId"]),

  proxy_tokens: defineTable({
    ownerId: v.string(),
    token: v.string(),
    agentType: v.string(),
    runId: v.string(),
    audience: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
    createdAt: v.number(),
    isAnonymous: v.optional(v.boolean()),
  })
    .index("by_token", ["token"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_expiresAt", ["expiresAt"]),
};
