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
    .index("by_ownerId_and_provider_and_updatedAt", ["ownerId", "provider", "updatedAt"])
    .index("by_keyVersion", ["keyVersion"]),

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

  auth_link_requests: defineTable({
    email: v.string(),
    requestId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
    ),
    ott: v.optional(v.string()),
    sessionCookie: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_requestId", ["requestId"])
    .index("by_email_and_createdAt", ["email", "createdAt"]),
};
