import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

type PaginatedResult = {
  page: Array<{ _id: string; isAnonymous?: boolean | null; updatedAt: number }>;
  continueCursor?: string;
  isDone?: boolean;
};

export const _listStaleAnonymousOwnerIds = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    cutoffMs: v.number(),
  },
  handler: async (ctx, args) => {
    const result: PaginatedResult = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "user" as const,
        where: [
          { field: "isAnonymous", value: true },
          { field: "updatedAt", operator: "lt" as const, value: args.cutoffMs },
        ],
        paginationOpts: { cursor: args.cursor, numItems: PAGE_SIZE },
      },
    );

    const ownerIds = result.page.map((u) => u._id);
    const done = result.isDone === true;

    return { ownerIds, nextCursor: done ? null : (result.continueCursor ?? null) };
  },
});

export const purgeStaleAnonymousData = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - STALE_THRESHOLD_MS;
    let cursor: string | null = null;
    let totalScheduled = 0;

    do {
      const batch = await ctx.runQuery(
        internal.anon_cleanup._listStaleAnonymousOwnerIds,
        { cursor, cutoffMs },
      );

      for (const ownerId of batch.ownerIds) {
        await ctx.scheduler.runAfter(
          0,
          internal.account_deletion.purgeOwnerCloudData,
          { ownerId },
        );
        totalScheduled++;
      }

      cursor = batch.nextCursor;
    } while (cursor !== null);

    if (totalScheduled > 0) {
      console.log(
        `[anon_cleanup] Scheduled purge for ${totalScheduled} stale anonymous users`,
      );
    }

    return null;
  },
});
