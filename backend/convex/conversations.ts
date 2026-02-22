import {
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUserId } from "./auth";
import {
  applyTokenDeltaWithSessionCompaction,
  ensureActiveConversationSession,
} from "./lib/orchestrator_sessions";

const conversationValidator = v.object({
  _id: v.id("conversations"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.optional(v.string()),
  isDefault: v.boolean(),
  activeSessionId: v.optional(v.id("conversation_sessions")),
  activeSessionTokenCount: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
  tokenCount: v.optional(v.number()),
  lastIngestedAt: v.optional(v.number()),
  lastExtractionAt: v.optional(v.number()),
  lastExtractionTokenCount: v.optional(v.number()),
});

const sessionValidator = v.object({
  _id: v.id("conversation_sessions"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  previousSessionId: v.optional(v.id("conversation_sessions")),
  sessionNumber: v.number(),
  startedAt: v.number(),
  closedAt: v.optional(v.number()),
  tokenCount: v.number(),
  compactionStatus: v.optional(v.string()),
  compactionSummary: v.optional(v.string()),
  compactionError: v.optional(v.string()),
  summarySourceConversationId: v.optional(v.id("conversations")),
  summarySourceSessionId: v.optional(v.id("conversation_sessions")),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const sessionCompactionNoticeValidator = v.object({
  activeSessionId: v.id("conversation_sessions"),
  previousSessionId: v.id("conversation_sessions"),
  previousSessionNumber: v.number(),
  compactionStatus: v.optional(v.string()),
  compactionSummary: v.optional(v.string()),
  compactionError: v.optional(v.string()),
});

const ensureConversationHasActiveSession = async (
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
): Promise<Doc<"conversations">> => {
  const { conversation: ensured } = await ensureActiveConversationSession(ctx, conversation);
  return ensured;
};

export const getById = internalQuery({
  args: { id: v.id("conversations") },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getOrCreateDefaultConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", ownerId).eq("isDefault", true),
      )
      .first();

    if (existing) {
      return await ensureConversationHasActiveSession(ctx, existing);
    }

    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "Default",
      isDefault: true,
      activeSessionTokenCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await ctx.db.get(id);
    if (!created) {
      return null;
    }
    return await ensureConversationHasActiveSession(ctx, created);
  },
});

export const createConversation = mutation({
  args: {
    title: v.optional(v.string()),
  },
  returns: v.union(conversationValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      ownerId,
      title: args.title ?? "New conversation",
      isDefault: false,
      activeSessionTokenCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const created = await ctx.db.get(id);
    if (!created) {
      return null;
    }
    return await ensureConversationHasActiveSession(ctx, created);
  },
});

export const patchTokenCount = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    tokenDelta: v.number(),
    countTowardSession: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyTokenDeltaWithSessionCompaction(ctx, {
      conversationId: args.conversationId,
      tokenDelta: args.tokenDelta,
      countTowardSession: args.countTowardSession,
    });
    return null;
  },
});

export const patchLastIngestedAt = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    lastIngestedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }
    const prev = conversation.lastIngestedAt ?? 0;
    const next = Math.max(prev, args.lastIngestedAt);
    if (next === prev) {
      return null;
    }
    await ctx.db.patch(args.conversationId, { lastIngestedAt: next });
    return null;
  },
});

export const patchExtractionCursor = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    lastExtractionAt: v.number(),
    lastExtractionTokenCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }

    const prevTime = conversation.lastExtractionAt ?? 0;
    const nextTime = Math.max(prevTime, args.lastExtractionAt);
    const nextTokenCount = args.lastExtractionTokenCount ?? conversation.tokenCount ?? conversation.lastExtractionTokenCount ?? 0;

    if (nextTime === prevTime && nextTokenCount === (conversation.lastExtractionTokenCount ?? 0)) {
      return null;
    }

    await ctx.db.patch(args.conversationId, {
      lastExtractionAt: nextTime,
      lastExtractionTokenCount: nextTokenCount,
    });
    return null;
  },
});

export const getActiveSession = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation?.activeSessionId) {
      return null;
    }
    return await ctx.db.get(conversation.activeSessionId);
  },
});

export const getSessionById = internalQuery({
  args: {
    sessionId: v.id("conversation_sessions"),
  },
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const getSessionCompactionNotice = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(sessionCompactionNoticeValidator, v.null()),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation?.activeSessionId) {
      return null;
    }

    const activeSession = await ctx.db.get(conversation.activeSessionId);
    if (!activeSession?.previousSessionId) {
      return null;
    }

    const previousSession = await ctx.db.get(activeSession.previousSessionId);
    if (!previousSession) {
      return null;
    }

    return {
      activeSessionId: activeSession._id,
      previousSessionId: previousSession._id,
      previousSessionNumber: previousSession.sessionNumber,
      compactionStatus: previousSession.compactionStatus,
      compactionSummary: previousSession.compactionSummary,
      compactionError: previousSession.compactionError,
    };
  },
});

export const ensureActiveSession = internalMutation({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.union(v.id("conversation_sessions"), v.null()),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) {
      return null;
    }
    const ensured = await ensureConversationHasActiveSession(ctx, conversation);
    return ensured.activeSessionId ?? null;
  },
});

