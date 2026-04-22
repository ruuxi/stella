import { defineTable } from "convex/server";
import { v } from "convex/values";
import { jsonObjectValidator } from "../shared_validators";

export const integrationsSchema = {
  integrations_public: defineTable({
    id: v.string(),
    provider: v.string(),
    enabled: v.boolean(),
    usagePolicy: v.string(),
    updatedAt: v.number(),
  })
    .index("by_integrationId", ["id"])
    // Lets `listPublicIntegrations` page over the catalog by recency without
    // a table scan (and gives us a natural ordering for clients).
    .index("by_updatedAt", ["updatedAt"]),

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

  transient_cleanup_failures: defineTable({
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    provider: v.string(),
    batchKeyHash: v.string(),
    attempts: v.number(),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_expiresAt", ["expiresAt"])
    .index("by_ownerId_and_createdAt", ["ownerId", "createdAt"])
    .index("by_provider_and_createdAt", ["provider", "createdAt"]),

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
  })
    .index("by_teamId", ["teamId"])
    .index("by_botTokenKeyVersion", ["botTokenKeyVersion"]),

  /**
   * Short-lived Slack OAuth state nonces. One row per outstanding `state`
   * value created by `createSlackInstallUrl`; consumed (or expired) when the
   * OAuth callback runs through `consumeSlackOAuthState`. `stateHash` is
   * `sha256(state)` (the `state` value itself carries 192 bits of entropy so
   * a plain hash is sufficient). Indexed by `stateHash` for O(1) lookup
   * instead of the previous global scan over `user_preferences`.
   */
  slack_oauth_states: defineTable({
    ownerId: v.string(),
    stateHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_ownerId_and_expiresAt", ["ownerId", "expiresAt"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * Short-lived link codes used by channel connectors (Linq, Slack, Discord,
   * Telegram, etc.) to bind a connector account to an existing Stella owner.
   * `codeHash` is a deterministic namespaced SHA-256 of `(provider, code)` so
   * that the consume path is a single indexed `.unique()` lookup instead of a
   * global scan over `user_preferences`. Codes carry a 5-minute TTL and are
   * rate-limited at the API surface; a sweeper cron purges expired rows.
   */
  link_codes: defineTable({
    ownerId: v.string(),
    provider: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_provider_and_codeHash", ["provider", "codeHash"])
    .index("by_ownerId_and_provider", ["ownerId", "provider"])
    .index("by_expiresAt", ["expiresAt"]),
};
