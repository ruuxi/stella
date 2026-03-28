import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

/**
 * Removes Convex-owned data for an owner before Better Auth deletes the user row.
 * Mirrors reset.resetAllUserData but takes an explicit owner id (used at account deletion time).
 */
export const purgeOwnerCloudData = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }) => {
    const conversationIds: Id<"conversations">[] = await ctx.runQuery(
      internal.reset._getConversationIds,
      { ownerId },
    );

    for (const conversationId of conversationIds) {
      let hasMore = true;
      while (hasMore) {
        const result: boolean = await ctx.runMutation(
          internal.reset._deleteConversationBatch,
          { conversationId },
        );
        hasMore = result;
      }
    }

    let hasMore = true;
    while (hasMore) {
      const result: boolean = await ctx.runMutation(internal.reset._deleteOwnerBatch, {
        ownerId,
      });
      hasMore = result;
    }

    return null;
  },
});
