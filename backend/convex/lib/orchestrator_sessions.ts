import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export const ORCHESTRATOR_SESSION_COMPACTION_TOKENS = 80_000;

type SessionCompactionResult = {
  tokenCount: number;
  activeSessionTokenCount: number;
  activeSessionId: Id<"conversation_sessions">;
  rolledOver: boolean;
  closedSessionId?: Id<"conversation_sessions">;
};

const createSession = async (
  ctx: MutationCtx,
  args: {
    conversationId: Id<"conversations">;
    sessionNumber: number;
    startedAt: number;
    previousSessionId?: Id<"conversation_sessions">;
  },
): Promise<Id<"conversation_sessions">> => {
  return await ctx.db.insert("conversation_sessions", {
    conversationId: args.conversationId,
    previousSessionId: args.previousSessionId,
    sessionNumber: args.sessionNumber,
    startedAt: args.startedAt,
    tokenCount: 0,
    createdAt: args.startedAt,
    updatedAt: args.startedAt,
  });
};

export const ensureActiveConversationSession = async (
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
): Promise<{
  conversation: Doc<"conversations">;
  session: Doc<"conversation_sessions">;
}> => {
  const now = Date.now();
  const activeSessionId = conversation.activeSessionId;
  if (activeSessionId) {
    const activeSession = await ctx.db.get(activeSessionId);
    if (activeSession && !activeSession.closedAt) {
      return {
        conversation,
        session: activeSession,
      };
    }
  }

  const latest = await ctx.db
    .query("conversation_sessions")
    .withIndex("by_conversationId_and_sessionNumber", (q) =>
      q.eq("conversationId", conversation._id),
    )
    .order("desc")
    .first();

  const nextSessionNumber = (latest?.sessionNumber ?? 0) + 1;
  const sessionId = await createSession(ctx, {
    conversationId: conversation._id,
    sessionNumber: nextSessionNumber,
    startedAt: now,
  });

  const updatedAt = Math.max(conversation.updatedAt, now);
  await ctx.db.patch(conversation._id, {
    activeSessionId: sessionId,
    activeSessionTokenCount: 0,
    updatedAt,
  });

  const createdSession = await ctx.db.get(sessionId);
  if (!createdSession) {
    throw new Error("Failed to create active orchestrator session.");
  }

  return {
    conversation: {
      ...conversation,
      activeSessionId: sessionId,
      activeSessionTokenCount: 0,
      updatedAt,
    },
    session: createdSession,
  };
};

export const resolveActiveConversationSession = async (
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
): Promise<{
  conversation: Doc<"conversations">;
  session: Doc<"conversation_sessions">;
}> => {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }
  return ensureActiveConversationSession(ctx, conversation);
};

export const applyTokenDeltaWithSessionCompaction = async (
  ctx: MutationCtx,
  args: {
    conversationId: Id<"conversations">;
    tokenDelta: number;
    countTowardSession?: boolean;
  },
): Promise<SessionCompactionResult | null> => {
  const tokenDelta = Number(args.tokenDelta);
  if (!Number.isFinite(tokenDelta) || tokenDelta <= 0) {
    return null;
  }

  const now = Date.now();
  const { conversation, session } = await resolveActiveConversationSession(
    ctx,
    args.conversationId,
  );

  const prevConversationTokenCount = conversation.tokenCount ?? 0;
  const nextConversationTokenCount = prevConversationTokenCount + tokenDelta;
  const countTowardSession = args.countTowardSession ?? true;

  if (!countTowardSession) {
    await ctx.db.patch(conversation._id, {
      tokenCount: nextConversationTokenCount,
      updatedAt: Math.max(conversation.updatedAt, now),
    });
    return {
      tokenCount: nextConversationTokenCount,
      activeSessionTokenCount: conversation.activeSessionTokenCount ?? session.tokenCount ?? 0,
      activeSessionId: session._id,
      rolledOver: false,
    };
  }

  const prevSessionTokenCount = session.tokenCount ?? conversation.activeSessionTokenCount ?? 0;
  const nextSessionTokenCount = prevSessionTokenCount + tokenDelta;

  await ctx.db.patch(session._id, {
    tokenCount: nextSessionTokenCount,
    updatedAt: now,
  });

  if (nextSessionTokenCount < ORCHESTRATOR_SESSION_COMPACTION_TOKENS) {
    await ctx.db.patch(conversation._id, {
      tokenCount: nextConversationTokenCount,
      activeSessionTokenCount: nextSessionTokenCount,
      updatedAt: Math.max(conversation.updatedAt, now),
    });
    return {
      tokenCount: nextConversationTokenCount,
      activeSessionTokenCount: nextSessionTokenCount,
      activeSessionId: session._id,
      rolledOver: false,
    };
  }

  await ctx.db.patch(session._id, {
    tokenCount: nextSessionTokenCount,
    closedAt: now,
    compactionStatus: "pending",
    compactionSummary: undefined,
    compactionError: undefined,
    summarySourceConversationId: conversation._id,
    summarySourceSessionId: session._id,
    updatedAt: now,
  });

  const nextSessionId = await createSession(ctx, {
    conversationId: conversation._id,
    sessionNumber: session.sessionNumber + 1,
    startedAt: now,
    previousSessionId: session._id,
  });

  await ctx.db.patch(conversation._id, {
    tokenCount: nextConversationTokenCount,
    activeSessionId: nextSessionId,
    activeSessionTokenCount: 0,
    updatedAt: Math.max(conversation.updatedAt, now),
  });

  await ctx.scheduler.runAfter(0, internal.data.session_compaction.generateSessionCompactionSummary, {
    sessionId: session._id,
  });

  return {
    tokenCount: nextConversationTokenCount,
    activeSessionTokenCount: 0,
    activeSessionId: nextSessionId,
    rolledOver: true,
    closedSessionId: session._id,
  };
};
