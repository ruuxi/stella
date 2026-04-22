import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Infer, v } from "convex/values";
import { requireUserId } from "./auth";
import {
  enforceActionRateLimit,
  RATE_SENSITIVE,
} from "./lib/rate_limits";

/**
 * Per-mutation deletion batch size. Conservative because each `reset.*` call
 * runs inside a single Convex transaction and we want to stay well below the
 * read/write limits even when the caller chains many invocations.
 */
const BATCH = 200;

/** How many conversation ids we'll fetch in one paginated page. */
const CONVERSATION_PAGE = 200;

/**
 * Tables that hold owner-scoped data and can be drained per-table without
 * needing per-conversation traversal. Each entry maps to the index that lets
 * us look the rows up by `ownerId`.
 *
 * Kept here as a typed tuple so the orchestrator action can iterate over them
 * without losing the strong typing on `ctx.db.query` / `withIndex`.
 */
const OWNER_TABLES = [
  ["user_preferences", "by_ownerId_and_key"],
  ["devices", "by_ownerId"],
  ["device_presence", "by_ownerId"],
  ["cloudflare_tunnels", "by_ownerId"],
  ["auth_session_policies", "by_ownerId"],
  ["usage_logs", "by_ownerId_and_createdAt"],
  ["billing_usage_windows", "by_ownerId"],
  ["billing_profiles", "by_ownerId"],
  ["user_counters", "by_ownerId"],
  ["slack_oauth_states", "by_ownerId_and_expiresAt"],
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number][0];

// ---------------------------------------------------------------------------
// Public action - orchestrates full user data reset across many small mutations
// ---------------------------------------------------------------------------

export const resetAllUserData = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);

    // Destructive: wipes the user's entire data set across many mutations.
    // A hijacked session shouldn't be able to fire-and-forget this multiple
    // times in parallel.
    await enforceActionRateLimit(
      ctx,
      "reset_all_user_data",
      ownerId,
      RATE_SENSITIVE,
      "Too many account reset attempts. Please wait a minute and try again.",
    );

    // 1. Drain conversations one page at a time. We don't store all ids in
    //    memory because a long-lived account could have up to
    //    `MAX_CONVERSATIONS_PER_USER` rows (1000), which exceeds the safe
    //    array-return size for a single query.
    let cursor: string | null = null;
    while (true) {
      const page: { ids: Id<"conversations">[]; nextCursor: string | null } =
        await ctx.runQuery(internal.reset._listConversationIdsPage, {
          ownerId,
          cursor,
        });

      for (const conversationId of page.ids) {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteConversationBatch,
            { conversationId },
          );
          hasMore = result.hasMore;
        }
      }

      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    // 2. Drain each owner-scoped table in its own mutation so we never
    //    read + delete from N tables in a single transaction. The per-table
    //    drains are independent, so run them concurrently.
    await Promise.all(
      OWNER_TABLES.map(async ([table]) => {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteOwnerTableBatch,
            { ownerId, table },
          );
          hasMore = result.hasMore;
        }
      }),
    );

    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export const _listConversationIdsPage = internalQuery({
  args: {
    ownerId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    ids: v.array(v.id("conversations")),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { ownerId, cursor }) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .paginate({ cursor, numItems: CONVERSATION_PAGE });
    return {
      ids: page.page.map((c) => c._id),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const _deleteConversationBatch = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { conversationId }) => {
    // Phase A: drain `events` for this conversation in tight batches. We
    // process events first so they always disappear before the conversation
    // row itself.
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (events.length > 0) {
      await Promise.all(events.map((e) => ctx.db.delete(e._id)));
      return { hasMore: true };
    }

    // Phase B: drain ONE thread's messages per call. Doing this per-thread
    // keeps the per-mutation read/write count bounded by `BATCH` even if a
    // conversation has hundreds of threads with thousands of messages each.
    const [thread] = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_lastUsedAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(1);
    if (thread) {
      const messages = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) =>
          q.eq("threadId", thread._id),
        )
        .take(BATCH);
      if (messages.length > 0) {
        await Promise.all(messages.map((m) => ctx.db.delete(m._id)));
        return { hasMore: true };
      }
      // No more messages for this thread — delete the thread row and let the
      // caller invoke us again to advance to the next thread / conversation
      // tear-down phase.
      await ctx.db.delete(thread._id);
      return { hasMore: true };
    }

    // Phase B': pending_device_selections is a child table keyed by
    // conversationId. Drain it before deleting the conversation row so we
    // don't leave dangling FK references.
    const pendingSelections = await ctx.db
      .query("pending_device_selections")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", conversationId))
      .take(BATCH);
    if (pendingSelections.length > 0) {
      await Promise.all(pendingSelections.map((row) => ctx.db.delete(row._id)));
      // The unique constraint means this almost always returns 0 or 1, so
      // we don't need a `hasMore: true` round-trip here.
    }

    // Phase C: events + threads are gone — delete the conversation row and
    // decrement the denormalized counter so quota checks stay accurate.
    const conv = await ctx.db.get(conversationId);
    if (conv) {
      await ctx.db.delete(conversationId);
      const counter = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", conv.ownerId))
        .unique();
      if (counter) {
        const next = Math.max(0, (counter.conversationCount ?? 0) - 1);
        await ctx.db.patch(counter._id, {
          conversationCount: next,
          updatedAt: Date.now(),
        });
      }
    }
    return { hasMore: false };
  },
});

const ownerTableValidator = v.union(
  v.literal("user_preferences"),
  v.literal("devices"),
  v.literal("device_presence"),
  v.literal("cloudflare_tunnels"),
  v.literal("auth_session_policies"),
  v.literal("usage_logs"),
  v.literal("billing_usage_windows"),
  v.literal("billing_profiles"),
  v.literal("user_counters"),
  v.literal("slack_oauth_states"),
);

// Static guard: keeps `ownerTableValidator` and `OWNER_TABLES` in sync. If
// a table is added/removed from one but not the other this file stops
// type-checking. Matches both directions so neither side can drift.
type _OwnerTableMatchesValidator =
  OwnerTable extends Infer<typeof ownerTableValidator>
    ? Infer<typeof ownerTableValidator> extends OwnerTable
      ? true
      : never
    : never;
const _ownerTablesInSync: _OwnerTableMatchesValidator = true;
void _ownerTablesInSync;

/**
 * Deletes one batch of rows from a single owner-scoped table. The orchestrator
 * action loops on `hasMore` and walks `OWNER_TABLES` so that each invocation
 * stays inside one mutation transaction.
 */
export const _deleteOwnerTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    table: ownerTableValidator,
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { ownerId, table }) => {
    const deleted = await deleteOneOwnerTableBatch(ctx, ownerId, table);
    return { hasMore: deleted === BATCH };
  },
});

/**
 * Per-table dispatch that keeps the typed `ctx.db.query` / `withIndex`
 * builder. Adding a new owner-scoped table here is a single switch case
 * addition (plus an entry in `OWNER_TABLES`).
 */
async function deleteOneOwnerTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: OwnerTable,
): Promise<number> {
  let ids: Id<OwnerTable>[] = [];
  switch (table) {
    case "user_preferences": {
      const rows = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "devices": {
      const rows = await ctx.db
        .query("devices")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "device_presence": {
      const rows = await ctx.db
        .query("device_presence")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "cloudflare_tunnels": {
      const rows = await ctx.db
        .query("cloudflare_tunnels")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "auth_session_policies": {
      const rows = await ctx.db
        .query("auth_session_policies")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "usage_logs": {
      const rows = await ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "billing_usage_windows": {
      const rows = await ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "billing_profiles": {
      const rows = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "user_counters": {
      const rows = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "slack_oauth_states": {
      const rows = await ctx.db
        .query("slack_oauth_states")
        .withIndex("by_ownerId_and_expiresAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}
