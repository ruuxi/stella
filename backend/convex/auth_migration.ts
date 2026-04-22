/**
 * Ownership migration for anonymous → real account linking.
 *
 * When an anonymous user signs in with a real identity, all owner-scoped
 * data must be transferred to the new ownerId. This module performs that
 * migration in batches to stay within Convex mutation limits.
 *
 * Each per-table migration is its own typed `internalMutation` so we keep the
 * `ctx.db.query` builder fully typed (no `as any` / `_id: any`). The
 * orchestrator action below walks the table list and re-invokes each batch
 * mutation until it returns `hasMore: false`.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";

const BATCH_SIZE = 500;

const ownerArgs = { fromOwnerId: v.string(), toOwnerId: v.string() } as const;
const hasMoreReturn = v.object({ hasMore: v.boolean() });

const isFullPage = (rows: readonly unknown[]) => rows.length === BATCH_SIZE;

// ---------------------------------------------------------------------------
// Per-table batch mutations.
//
// Each one stays inside the schema's strong typing for `ctx.db.patch` so we
// don't need a `db.patch as unknown as ...` widening — the compiler proves
// that `{ ownerId }` is a valid partial patch for each table.
// ---------------------------------------------------------------------------

export const migrateConversationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserPreferencesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAuthSessionPoliciesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("auth_session_policies")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretAccessAuditBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secret_access_audit")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserIntegrationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUsageLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateTransientChannelEventsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("transient_channel_events")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateTransientCleanupFailuresBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("transient_cleanup_failures")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAgentsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_job_logs")
      .withIndex("by_ownerId_and_jobId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserCountersBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
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
  returns: v.null(),
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
  returns: v.null(),
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
 * Tables whose batches are independent of every other table — drainable in
 * parallel from the orchestrator. `devices` / `device_presence` /
 * `channel_connections` are NOT here: they go through
 * `migrateDevicesForAccountLink` because that mutation enforces the
 * devices→presence→connections write order to keep partial migrations
 * consistent.
 */
const PARALLEL_TABLE_MUTATIONS = [
  internal.auth_migration.migrateConversationsBatch,
  internal.auth_migration.migrateUserPreferencesBatch,
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
  internal.auth_migration.migrateSecretsBatch,
  internal.auth_migration.migrateSecretAccessAuditBatch,
  internal.auth_migration.migrateUserIntegrationsBatch,
  internal.auth_migration.migrateUsageLogsBatch,
  internal.auth_migration.migrateTransientChannelEventsBatch,
  internal.auth_migration.migrateTransientCleanupFailuresBatch,
  internal.auth_migration.migrateAgentsBatch,
  internal.auth_migration.migrateMediaJobsBatch,
  internal.auth_migration.migrateMediaJobLogsBatch,
  internal.auth_migration.migrateUserCountersBatch,
  internal.auth_migration.migratePersistChunksBatch,
] as const;

type OwnerBatchMutation = FunctionReference<
  "mutation",
  "internal",
  { fromOwnerId: string; toOwnerId: string },
  { hasMore: boolean }
>;

/**
 * Drain a single per-table batch mutation by repeatedly invoking it until
 * `hasMore: false`. Each invocation is its own Convex transaction so the
 * mutation stays inside the per-mutation read/write limits.
 */
async function drainTableMutation(
  ctx: ActionCtx,
  mutation: OwnerBatchMutation,
  args: { fromOwnerId: string; toOwnerId: string },
): Promise<void> {
  let hasMore = true;
  while (hasMore) {
    const result = await ctx.runMutation(mutation, args);
    hasMore = result.hasMore;
  }
}

/**
 * Orchestrate the full ownership migration across all tables. Called
 * asynchronously via scheduler when an anonymous user links to a real
 * account.
 *
 * Tables whose drain is independent run concurrently (`Promise.all`) so a
 * tenant with data in many tables doesn't pay the sum of every per-table
 * round-trip. The devices/presence/connections migration runs first and
 * sequentially because `migrateDevicesForAccountLink` enforces a strict
 * order across those three tables.
 */
export const migrateOwnership = internalAction({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.null(),
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

    await Promise.all(
      PARALLEL_TABLE_MUTATIONS.map((mutation) =>
        drainTableMutation(ctx, mutation as OwnerBatchMutation, {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        }),
      ),
    );

    // Deduplicate default conversations and per-owner counters that may now
    // have collided with the destination owner's pre-existing rows. These
    // depend on the per-table migrations finishing first.
    await Promise.all([
      ctx.runMutation(internal.auth_migration.deduplicateDefaultConversation, {
        toOwnerId: args.toOwnerId,
      }),
      ctx.runMutation(internal.auth_migration.deduplicateUserCounters, {
        toOwnerId: args.toOwnerId,
      }),
    ]);

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
 * Migrate persist_chunks which uses `by_ownerId` rather than the standard
 * `by_ownerId_and_updatedAt` shape.
 */
export const migratePersistChunksBatch = internalMutation({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("persist_chunks")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );

    return { hasMore: rows.length === BATCH_SIZE };
  },
});
