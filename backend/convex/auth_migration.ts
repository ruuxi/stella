/**
 * Ownership migration for anonymous → real account linking.
 *
 * When an anonymous user signs in with a real identity, all owner-scoped
 * data must be transferred to the new ownerId. This module performs that
 * migration in batches to stay within Convex mutation limits.
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const BATCH_SIZE = 500;

/**
 * All tables with an `ownerId` field that need migration.
 * Each entry maps to the index used for querying by ownerId.
 */
const OWNER_TABLES: Array<{
  table: string;
  index: string;
}> = [
  { table: "conversations", index: "by_ownerId_and_updatedAt" },
  { table: "user_preferences", index: "by_ownerId_and_key" },
  { table: "memories", index: "by_ownerId_and_accessedAt" },
  { table: "event_embeddings", index: "by_ownerId_and_timestamp" },
{ table: "devices", index: "by_ownerId" },
  { table: "cloud_devices", index: "by_ownerId" },
  { table: "auth_session_policies", index: "by_ownerId" },
  { table: "secrets", index: "by_ownerId_and_updatedAt" },
  { table: "secret_access_audit", index: "by_ownerId_and_createdAt" },
  { table: "user_integrations", index: "by_ownerId_and_updatedAt" },
  { table: "remote_computers", index: "by_ownerId_and_updatedAt" },
  { table: "usage_logs", index: "by_ownerId_and_createdAt" },
  { table: "persist_chunks", index: "by_chunkKey" },
  { table: "heartbeat_configs", index: "by_ownerId_and_updatedAt" },
  { table: "channel_connections", index: "by_ownerId_and_provider" },
  { table: "transient_channel_events", index: "by_ownerId_and_createdAt" },
  { table: "transient_cleanup_failures", index: "by_ownerId_and_createdAt" },
  { table: "bridge_sessions", index: "by_ownerId_and_provider" },
  { table: "bridge_outbound", index: "by_ownerId_and_createdAt" },
  { table: "cron_jobs", index: "by_ownerId_and_updatedAt" },
  { table: "skills", index: "by_ownerId_and_updatedAt" },
  { table: "agents", index: "by_ownerId_and_updatedAt" },
];

/**
 * Migrate a batch of records in a single table from one ownerId to another.
 * Returns true if there are more records to migrate.
 */
export const migrateTableBatch = internalMutation({
  args: {
    table: v.string(),
    index: v.string(),
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Dynamic table/index names require casting the typed query builder.
    const db = ctx.db as unknown as {
      query(table: string): {
        withIndex(
          name: string,
          pred: (q: { eq: (field: string, value: string) => unknown }) => unknown,
        ): { take(n: number): Promise<Array<{ _id: any; ownerId: string }>> };
      };
    };
    const rows = await db
      .query(args.table)
      .withIndex(args.index, (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    for (const row of rows) {
      await ctx.db.patch(row._id as any, { ownerId: args.toOwnerId });
    }

    return rows.length === BATCH_SIZE;
  },
});

/**
 * Deduplicate default conversations after migration.
 * If the target user already has a default conversation, un-default the
 * migrated ones to avoid constraint violations.
 */
export const deduplicateDefaultConversation = internalMutation({
  args: {
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const defaults = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("isDefault", true),
      )
      .collect();

    if (defaults.length <= 1) return null;

    // Keep the oldest default, un-default the rest
    defaults.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < defaults.length; i++) {
      await ctx.db.patch(defaults[i]._id, { isDefault: false });
    }

    return null;
  },
});

/**
 * Orchestrate the full ownership migration across all tables.
 * Called asynchronously via scheduler when an anonymous user links to a real
 * account.
 */
export const migrateOwnership = internalAction({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;

    for (const { table, index } of OWNER_TABLES) {
      // persist_chunks doesn't have an ownerId-first index, skip index query
      // and use a scan-based fallback
      if (table === "persist_chunks") {
        continue;
      }

      let hasMore = true;
      while (hasMore) {
        hasMore = await ctx.runMutation(
          internal.auth_migration.migrateTableBatch,
          {
            table,
            index,
            fromOwnerId: args.fromOwnerId,
            toOwnerId: args.toOwnerId,
          },
        );
      }
    }

    // Handle persist_chunks separately (uses by_chunkKey, not by_ownerId)
    let hasMore = true;
    while (hasMore) {
      hasMore = await ctx.runMutation(
        internal.auth_migration.migratePersistChunksBatch,
        {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        },
      );
    }

    // Deduplicate default conversations
    await ctx.runMutation(internal.auth_migration.deduplicateDefaultConversation, {
      toOwnerId: args.toOwnerId,
    });

    console.log(
      `[auth_migration] Completed ownership migration from ${args.fromOwnerId} to ${args.toOwnerId}`,
    );
    return null;
  },
});

/**
 * Migrate persist_chunks which doesn't have a standard ownerId index.
 */
export const migratePersistChunksBatch = internalMutation({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // persist_chunks doesn't have a by_ownerId index, so we scan
    const rows = await ctx.db
      .query("persist_chunks")
      .filter((q) => q.eq(q.field("ownerId"), args.fromOwnerId))
      .take(BATCH_SIZE);

    for (const row of rows) {
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
    }

    return rows.length === BATCH_SIZE;
  },
});
