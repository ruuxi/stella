import {
  action,
  internalMutation,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { TableNames } from "./_generated/dataModel";
import { v } from "convex/values";

const BATCH = 500;
const APP_TABLES: TableNames[] = [
  "conversations",
  "events",
  "attachments",
  "agents",
  "commands",
  "skills",
  "secrets",
  "secret_access_audit",
  "integrations_public",
  "user_integrations",
  "remote_computers",
  "devices",
  "auth_session_policies",
  "cloud_devices",
  "user_preferences",
  "tasks",
  "threads",
  "thread_messages",
  "memories",
  "event_embeddings",
  "heartbeat_configs",
  "channel_connections",
  "transient_channel_events",
  "transient_cleanup_failures",
  "slack_installations",
  "bridge_sessions",
  "bridge_outbound",
  "store_packages",
  "store_installs",
  "canvas_states",
  "dashboard_pages",
  "self_mod_features",
  "linq_chats",
  "proxy_tokens",
  "persist_chunks",
  "usage_logs",
  "anon_device_usage",
  "cron_jobs",
];
const APP_TABLE_SET = new Set<string>(APP_TABLES);
const AUTH_MODELS = [
  "user",
  "session",
  "account",
  "verification",
  "twoFactor",
  "passkey",
  "oauthApplication",
  "oauthAccessToken",
  "oauthConsent",
  "jwks",
  "rateLimit",
] as const;

// Public action: clear all Convex data for a full onboarding reset.
export const resetAllUserData = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let hasScheduled = true;
    while (hasScheduled) {
      hasScheduled = await ctx.runMutation(
        internal.reset._cancelScheduledFunctionBatch,
        {},
      );
    }

    for (const table of APP_TABLES) {
      let hasMore = true;
      while (hasMore) {
        hasMore = await ctx.runMutation(internal.reset._deleteTableBatch, {
          table,
        });
      }
    }

    let hasStorage = true;
    while (hasStorage) {
      hasStorage = await ctx.runMutation(internal.reset._deleteStorageBatch, {});
    }

    for (const model of AUTH_MODELS) {
      // better-auth adapter deleteMany is paginated; loop until each model drains.
      for (let attempts = 0; attempts < 200; attempts += 1) {
        const result = await ctx.runMutation(
          components.betterAuth.adapter.deleteMany,
          {
            input: { model },
            paginationOpts: { cursor: null, numItems: BATCH },
          },
        );

        const deletedCount =
          typeof result === "number"
            ? result
            : typeof result === "object" && result !== null
              ? (
                  ("deleted" in result && typeof result.deleted === "number" && result.deleted) ||
                  ("count" in result && typeof result.count === "number" && result.count) ||
                  ("numDeleted" in result && typeof result.numDeleted === "number" && result.numDeleted) ||
                  (Array.isArray((result as { items?: unknown[] }).items)
                    ? (result as { items: unknown[] }).items.length
                    : 0) ||
                  (Array.isArray((result as { data?: unknown[] }).data)
                    ? (result as { data: unknown[] }).data.length
                    : 0)
                )
              : 0;

        if (deletedCount < BATCH) {
          break;
        }
      }
    }

    await ctx.runMutation(components.rateLimiter.lib.clearAll, {});

    return null;
  },
});

export const _cancelScheduledFunctionBatch = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const scheduledFunctions = await ctx.db.system
      .query("_scheduled_functions")
      .take(BATCH);
    for (const scheduled of scheduledFunctions) {
      await ctx.scheduler.cancel(scheduled._id);
    }
    return scheduledFunctions.length === BATCH;
  },
});

export const _deleteTableBatch = internalMutation({
  args: { table: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { table }) => {
    if (!APP_TABLE_SET.has(table)) {
      return false;
    }

    const tableName = table as TableNames;
    const rows = await ctx.db.query(tableName).take(BATCH);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length === BATCH;
  },
});

export const _deleteStorageBatch = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const files = await ctx.db.system.query("_storage").take(BATCH);
    for (const file of files) {
      await ctx.storage.delete(file._id);
    }
    return files.length === BATCH;
  },
});
