import {
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "./auth";
import { RateLimiter } from "@convex-dev/rate-limiter";
import {
  pendingDeviceSelectionValidator,
} from "./schema/conversations";

const rateLimiter = new RateLimiter(components.rateLimiter);

/**
 * Adjust the denormalized `conversationCount` counter for an owner by `delta`.
 * Lazily creates the counter row when missing. Counters never go negative.
 */
const adjustConversationCount = async (
  ctx: MutationCtx,
  ownerId: string,
  delta: number,
) => {
  const now = Date.now();
  const existing = await ctx.db
    .query("user_counters")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (!existing) {
    await ctx.db.insert("user_counters", {
      ownerId,
      conversationCount: Math.max(0, delta),
      updatedAt: now,
    });
    return Math.max(0, delta);
  }
  const next = Math.max(0, (existing.conversationCount ?? 0) + delta);
  await ctx.db.patch(existing._id, {
    conversationCount: next,
    updatedAt: now,
  });
  return next;
};

const conversationDocValidator = v.union(v.null(), v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.optional(v.string()),
  isDefault: v.boolean(),
  activeThreadId: v.optional(v.id("threads")),
  activeTargetDeviceId: v.optional(v.string()),
  pendingDeviceSelection: v.optional(pendingDeviceSelectionValidator),
  eventCount: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
}));

const conversationRoutingStateValidator = v.object({
  activeTargetDeviceId: v.union(v.string(), v.null()),
  pendingDeviceSelection: v.union(v.null(), pendingDeviceSelectionValidator),
});

export const getById = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getOrCreateDefaultConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: conversationDocValidator,
  handler: async (ctx, args) => {
    if (args.title && args.title.length > 200) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Conversation title exceeds maximum allowed length of 200 characters",
      });
    }

    const ownerId = await requireUserId(ctx);

    const status = await rateLimiter.limit(ctx, "createConversation", {
      key: ownerId,
      config: { kind: "fixed window", rate: 20, period: 10000 },
    });
    if (!status.ok) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many conversation requests. Please try again later.",
      });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", ownerId).eq("isDefault", true),
      )
      .unique();

    if (existing) {
      if (!existing.activeThreadId) {
        const { threadId } = await ctx.runMutation(internal.data.threads.createThread, {
          ownerId,
          conversationId: existing._id,
          name: "Main",
        });
        await ctx.db.patch(existing._id, { activeThreadId: threadId });
        return await ctx.db.get(existing._id);
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "Default",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
    await adjustConversationCount(ctx, ownerId, 1);

    const { threadId } = await ctx.runMutation(internal.data.threads.createThread, {
      ownerId,
      conversationId: id,
      name: "Main",
    });

    await ctx.db.patch(id, { activeThreadId: threadId });

    const created = await ctx.db.get(id);
    return created;
  },
});

const MAX_CONVERSATIONS_PER_USER = 1000;

export const createConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: conversationDocValidator,
  handler: async (ctx, args) => {
    if (args.title && args.title.length > 200) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Conversation title exceeds maximum allowed length of 200 characters",
      });
    }

    const ownerId = await requireUserId(ctx);

    const status = await rateLimiter.limit(ctx, "createConversation", {
      key: ownerId,
      config: { kind: "fixed window", rate: 20, period: 10000 },
    });
    if (!status.ok) {
      throw new ConvexError({
        code: "RATE_LIMITED",
        message: "Too many conversation requests. Please try again later.",
      });
    }

    // O(1) quota check via the denormalized `user_counters` row maintained
    // by every conversation insert/delete, instead of scanning up to
    // `MAX_CONVERSATIONS_PER_USER` rows of the conversations table.
    const counter = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
      .unique();
    const currentCount = counter?.conversationCount ?? 0;
    if (currentCount >= MAX_CONVERSATIONS_PER_USER) {
      throw new ConvexError({
        code: "LIMIT_EXCEEDED",
        message: `You have reached the maximum of ${MAX_CONVERSATIONS_PER_USER} conversations. Please delete some before creating new ones.`,
      });
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "New conversation",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    await adjustConversationCount(ctx, ownerId, 1);

    const { threadId } = await ctx.runMutation(internal.data.threads.createThread, {
      ownerId,
      conversationId: id,
      name: "Main",
    });

    await ctx.db.patch(id, { activeThreadId: threadId });

    const created = await ctx.db.get(id);
    return created;
  },
});

export const getActiveThreadId = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    return conversation?.activeThreadId ?? null;
  },
});

export const getRoutingState = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: conversationRoutingStateValidator,
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    return {
      activeTargetDeviceId: conversation?.activeTargetDeviceId ?? null,
      pendingDeviceSelection: conversation?.pendingDeviceSelection ?? null,
    };
  },
});

export const setActiveThreadId = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      activeThreadId: args.threadId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setActiveTargetDeviceId = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    deviceId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      activeTargetDeviceId: args.deviceId,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const setPendingDeviceSelection = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    selection: pendingDeviceSelectionValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      pendingDeviceSelection: args.selection,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const clearPendingDeviceSelection = internalMutation({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      pendingDeviceSelection: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});


