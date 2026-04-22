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
  { table: "auth_session_policies", index: "by_ownerId" },
  { table: "secrets", index: "by_ownerId_and_updatedAt" },
  { table: "secret_access_audit", index: "by_ownerId_and_createdAt" },
  { table: "user_integrations", index: "by_ownerId_and_updatedAt" },
  { table: "usage_logs", index: "by_ownerId_and_createdAt" },
  // channel_connections is migrated atomically with devices — see migrateDevicesForAccountLink
  { table: "transient_channel_events", index: "by_ownerId_and_createdAt" },
  { table: "transient_cleanup_failures", index: "by_ownerId_and_createdAt" },
  { table: "agents", index: "by_ownerId_and_updatedAt" },
  { table: "media_jobs", index: "by_ownerId_and_createdAt" },
  { table: "media_job_logs", index: "by_ownerId_and_jobId" },
  { table: "user_counters", index: "by_ownerId" },
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

    const promises = rows.map((row) => ctx.db.patch(row._id as any, { ownerId: args.toOwnerId }));
    await Promise.all(promises);

    return rows.length === BATCH_SIZE;
  },
});

/** Bound on how many duplicate-default conversations we'll consider. */
const DEDUPLICATE_DEFAULT_BATCH = 200;

/**
 * Deduplicate default conversations after migration.
 * If the target user already has a default conversation, un-default the
 * migrated ones to avoid constraint violations.
 */
export const deduplicateDefaultConversation = internalMutation({
  args: {
    toOwnerId: v.string(),
  },
  handler: async (ctx, args) => {
    const defaults = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("isDefault", true),
      )
      .take(DEDUPLICATE_DEFAULT_BATCH);

    if (defaults.length <= 1) return null;

    defaults.sort((a, b) => a.createdAt - b.createdAt);
    const promises = [];
    for (let i = 1; i < defaults.length; i++) {
      promises.push(ctx.db.patch(defaults[i]._id, { isDefault: false }));
    }
    await Promise.all(promises);

    return null;
  },
});

/**
 * After ownership migration, both the source and destination owner may have
 * a `user_counters` row. Collapse them by summing the conversation counts
 * into the oldest row and deleting the duplicates so future quota lookups
 * find a single row via `unique()`.
 */
export const deduplicateUserCounters = internalMutation({
  args: { toOwnerId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .take(64);

    if (rows.length <= 1) return null;

    rows.sort((a, b) => a._creationTime - b._creationTime);
    const [primary, ...duplicates] = rows;
    const totalCount = rows.reduce(
      (sum, row) => sum + (row.conversationCount ?? 0),
      0,
    );
    await ctx.db.patch(primary._id, {
      conversationCount: totalCount,
      updatedAt: Date.now(),
    });
    await Promise.all(duplicates.map((row) => ctx.db.delete(row._id)));
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
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;

    let deviceMigrationHasMore = true;
    while (deviceMigrationHasMore) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.auth_migration.migrateDevicesForAccountLink,
        {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        },
      );
      deviceMigrationHasMore = result.hasMore;
    }

    for (const { table, index } of OWNER_TABLES) {
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

    // Deduplicate default conversations and per-owner counters that may now
    // have collided with the destination owner's pre-existing rows.
    await ctx.runMutation(internal.auth_migration.deduplicateDefaultConversation, {
      toOwnerId: args.toOwnerId,
    });
    await ctx.runMutation(internal.auth_migration.deduplicateUserCounters, {
      toOwnerId: args.toOwnerId,
    });

    console.log(
      `[auth_migration] Completed ownership migration from ${args.fromOwnerId} to ${args.toOwnerId}`,
    );
    return null;
  },
});

/**
 * Migrate devices, device_presence and channel_connections rows for an
 * account-link in bounded batches. Each invocation processes at most
 * `BATCH_SIZE` rows per table and returns `hasMore` so the caller
 * (`migrateOwnership`) can re-invoke until all three tables are drained,
 * staying within Convex mutation transaction limits even for owners with
 * many devices/presence rows/connections.
 *
 * Migration order is preserved across batches: presence migrates after
 * devices and connections after presence, so a partial migration never
 * leaves the system with a connection that points to the old owner while
 * devices have already moved.
 */
export const migrateDevicesForAccountLink = internalMutation({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    // --- devices (stable profile rows) ---
    const deviceRows = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    if (deviceRows.length > 0) {
      for (const row of deviceRows) {
        const existing = await ctx.db
          .query("devices")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
          )
          .unique();

        if (existing) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
        }
      }
      return { hasMore: deviceRows.length === BATCH_SIZE };
    }

    // --- device_presence (high-churn) ---
    const presenceRows = await ctx.db
      .query("device_presence")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    if (presenceRows.length > 0) {
      for (const row of presenceRows) {
        const existing = await ctx.db
          .query("device_presence")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
          )
          .unique();

        if (existing) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
        }
      }
      return { hasMore: presenceRows.length === BATCH_SIZE };
    }

    // --- channel_connections ---
    const connectionRows = await ctx.db
      .query("channel_connections")
      .withIndex("by_ownerId_and_provider", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);

    for (const row of connectionRows) {
      await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
    }
    return { hasMore: connectionRows.length === BATCH_SIZE };
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
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("persist_chunks")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    const promises = rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId }));
    await Promise.all(promises);

    return rows.length === BATCH_SIZE;
  },
});


