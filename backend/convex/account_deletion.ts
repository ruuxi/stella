import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

const OWNER_TABLES = [
  "user_preferences",
  "devices",
  "device_presence",
  "cloudflare_tunnels",
  "auth_session_policies",
  "usage_logs",
  "billing_usage_windows",
  "billing_profiles",
  "user_counters",
  "slack_oauth_states",
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number];

/**
 * Drain a single owner-scoped table by repeatedly invoking
 * `_deleteOwnerTableBatch` until `hasMore: false`. Each invocation is its
 * own Convex transaction so the per-mutation read/write limits stay
 * respected.
 */
const drainOwnerTable = async (
  ctx: ActionCtx,
  ownerId: string,
  table: OwnerTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.reset._deleteOwnerTableBatch,
      { ownerId, table },
    );
    hasMore = result.hasMore;
  }
};

/**
 * Removes Convex-owned data for an owner before Better Auth deletes the user
 * row. Mirrors `reset.resetAllUserData` but takes an explicit owner id (used
 * at account-deletion time, when there is no `ctx.auth.getUserIdentity()`).
 */
export const purgeOwnerCloudData = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }) => {
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

    // Owner-scoped tables are independent — drain them concurrently.
    await Promise.all(
      OWNER_TABLES.map((table) => drainOwnerTable(ctx, ownerId, table)),
    );

    return null;
  },
});
