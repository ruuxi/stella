import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { generateText } from "ai";
import { getModelConfig } from "../agent/model";
import {
  findRecentStartIndexByTokens,
  formatThreadMessagesForCompaction,
} from "./thread_compaction_format";

const MAX_THREADS_PER_CONVERSATION = 16;
const MAX_CONTENT_LENGTH = 500_000;
const MIN_MESSAGES_FOR_COMPACTION = 6;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

const THREAD_COMPACTION_PROMPT = `You are summarizing a work session for an AI coding agent.
This summary will be injected as context when the agent resumes this work later.

Preserve with high fidelity:
- The task objective and current progress
- Key decisions and their rationale
- File paths, function names, error messages, technical details
- What was tried and outcomes
- What remains to be done

Write a dense, factual summary in 200-500 words using bullet points.
Output ONLY the summary content.`;

const THREAD_COMPACTION_UPDATE_PROMPT = `You are updating an existing session summary for an AI coding agent.
You receive:
- <previous-summary>: the earlier session summary
- <conversation>: newer messages not yet folded in

Update the summary with high fidelity:
- Preserve prior key context unless superseded
- Add new progress, decisions, errors, and outcomes
- Keep exact file paths, function names, and error text
- Note what remains to be done

Write a dense, factual summary in 200-500 words using bullet points.
Output ONLY the updated summary content.`;

const threadValidator = v.object({
  _id: v.id("threads"),
  _creationTime: v.number(),
  conversationId: v.id("conversations"),
  name: v.string(),
  status: v.string(),
  summary: v.optional(v.string()),
  messageCount: v.number(),
  totalTokenEstimate: v.number(),
  createdAt: v.number(),
  lastUsedAt: v.number(),
  closedAt: v.optional(v.number()),
});

const threadMessageValidator = v.object({
  _id: v.id("thread_messages"),
  _creationTime: v.number(),
  threadId: v.id("threads"),
  ordinal: v.number(),
  role: v.string(),
  content: v.string(),
  toolCallId: v.optional(v.string()),
  tokenEstimate: v.optional(v.number()),
  createdAt: v.number(),
});

// ---------------------------------------------------------------------------
// Truncate large content to prevent DB bloat
// ---------------------------------------------------------------------------

const truncateContent = (raw: string): string => {
  if (raw.length > MAX_CONTENT_LENGTH) {
    return raw.slice(0, MAX_CONTENT_LENGTH) + '"...[truncated]"';
  }
  return raw;
};

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

export const createThread = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  returns: v.id("threads"),
  handler: async (ctx, args) => {
    // Check active thread count and evict if at limit
    const activeThreads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    if (activeThreads.length >= MAX_THREADS_PER_CONVERSATION) {
      // Evict the oldest (least recently used)
      const sorted = activeThreads.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const oldest = sorted[0];
      if (oldest) {
        await ctx.db.patch(oldest._id, {
          status: "closed",
          closedAt: Date.now(),
        });
      }
    }

    const now = Date.now();
    return await ctx.db.insert("threads", {
      conversationId: args.conversationId,
      name: args.name,
      status: "active",
      messageCount: 0,
      totalTokenEstimate: 0,
      createdAt: now,
      lastUsedAt: now,
    });
  },
});

// ---------------------------------------------------------------------------
// getThreadByName
// ---------------------------------------------------------------------------

export const getThreadByName = internalQuery({
  args: {
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  returns: v.union(threadValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("threads")
      .withIndex("by_conversation_name", (q) =>
        q.eq("conversationId", args.conversationId).eq("name", args.name),
      )
      .first();
  },
});

// ---------------------------------------------------------------------------
// getThreadById
// ---------------------------------------------------------------------------

export const getThreadById = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.union(threadValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.threadId);
  },
});

// ---------------------------------------------------------------------------
// listActiveThreads
// ---------------------------------------------------------------------------

export const listActiveThreads = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(threadValidator),
  handler: async (ctx, args) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    // Sort by lastUsedAt desc (most recent first)
    return threads.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  },
});

// ---------------------------------------------------------------------------
// touchThread
// ---------------------------------------------------------------------------

export const touchThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, {
      lastUsedAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// closeThread
// ---------------------------------------------------------------------------

export const closeThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      status: "closed",
      closedAt: now,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// loadThreadMessages
// ---------------------------------------------------------------------------

export const loadThreadMessages = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(threadMessageValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("thread_messages")
      .withIndex("by_thread_ordinal", (q) =>
        q.eq("threadId", args.threadId),
      )
      .collect();
  },
});

// ---------------------------------------------------------------------------
// saveThreadMessages
// ---------------------------------------------------------------------------

export const saveThreadMessages = internalMutation({
  args: {
    threadId: v.id("threads"),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        toolCallId: v.optional(v.string()),
        tokenEstimate: v.optional(v.number()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.messages.length === 0) return null;

    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;

    // Get the current max ordinal
    const lastMessage = await ctx.db
      .query("thread_messages")
      .withIndex("by_thread_ordinal", (q) =>
        q.eq("threadId", args.threadId),
      )
      .order("desc")
      .first();

    let nextOrdinal = (lastMessage?.ordinal ?? -1) + 1;
    let addedTokens = 0;
    const now = Date.now();

    for (const msg of args.messages) {
      const safeContent = truncateContent(msg.content);
      const estimate = msg.tokenEstimate ?? Math.ceil(safeContent.length / 4);
      addedTokens += estimate;

      await ctx.db.insert("thread_messages", {
        threadId: args.threadId,
        ordinal: nextOrdinal++,
        role: msg.role,
        content: safeContent,
        toolCallId: msg.toolCallId,
        tokenEstimate: estimate,
        createdAt: now,
      });
    }

    // Update thread counters
    await ctx.db.patch(args.threadId, {
      messageCount: thread.messageCount + args.messages.length,
      totalTokenEstimate: thread.totalTokenEstimate + addedTokens,
      lastUsedAt: now,
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// deleteMessagesBefore
// ---------------------------------------------------------------------------

export const deleteMessagesBefore = internalMutation({
  args: {
    threadId: v.id("threads"),
    beforeOrdinal: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("thread_messages")
      .withIndex("by_thread_ordinal", (q) =>
        q.eq("threadId", args.threadId),
      )
      .collect();

    let deleted = 0;
    for (const msg of messages) {
      if (msg.ordinal < args.beforeOrdinal) {
        await ctx.db.delete(msg._id);
        deleted++;
      }
    }

    return deleted;
  },
});

// ---------------------------------------------------------------------------
// evictOldestThread
// ---------------------------------------------------------------------------

export const evictOldestThread = internalMutation({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const oldest = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .first();

    if (oldest) {
      await ctx.db.patch(oldest._id, {
        status: "closed",
        closedAt: Date.now(),
      });
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// compactThread (internal action — uses LLM to summarize old messages)
// ---------------------------------------------------------------------------

export const compactThread = internalAction({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // 1. Load thread metadata
    const thread = await ctx.runQuery(internal.data.threads.getThreadById, {
      threadId: args.threadId,
    });
    if (!thread || thread.status !== "active") return null;

    // 2. Load all messages
    const messages = await ctx.runQuery(internal.data.threads.loadThreadMessages, {
      threadId: args.threadId,
    });

    // 3. Skip if too few messages
    if (messages.length <= MIN_MESSAGES_FOR_COMPACTION) return null;

    // 4. Split: keep recent token budget, but avoid splitting a turn mid-flow.
    const recentStartIndex = findRecentStartIndexByTokens(
      messages,
      THREAD_COMPACTION_KEEP_RECENT_TOKENS,
    );
    const oldMessages = messages.slice(0, recentStartIndex);
    const recentMessages = messages.slice(recentStartIndex);

    if (oldMessages.length === 0) return null;

    // 5. Format old messages for summarization (tool-aware, role-aware).
    const oldText = formatThreadMessagesForCompaction(
      oldMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    );
    if (oldText.trim().length === 0) return null;

    // 6. Call LLM to summarize or incrementally update.
    const hasPreviousSummary = Boolean(thread.summary && thread.summary.trim().length > 0);
    const promptBody = [
      `<conversation>\n${oldText}\n</conversation>`,
      hasPreviousSummary ? `<previous-summary>\n${thread.summary!.trim()}\n</previous-summary>` : "",
      hasPreviousSummary ? THREAD_COMPACTION_UPDATE_PROMPT : THREAD_COMPACTION_PROMPT,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const config = getModelConfig("memory_ops");
    const { text: newSummary } = await generateText({
      ...config,
      system: "Output ONLY the summary content.",
      messages: [
        {
          role: "user",
          content: promptBody,
        },
      ],
    });
    const summary = newSummary.trim();
    if (summary.length === 0) return null;

    // 7. Delete old messages
    const firstRecentOrdinal = recentMessages[0].ordinal;
    await ctx.runMutation(internal.data.threads.deleteMessagesBefore, {
      threadId: args.threadId,
      beforeOrdinal: firstRecentOrdinal,
    });

    // 8. Recompute counters and update thread
    const remainingTokens = recentMessages.reduce(
      (sum, m) => sum + (m.tokenEstimate ?? 0),
      0,
    );

    await ctx.runMutation(internal.data.threads.patchThreadAfterCompaction, {
      threadId: args.threadId,
      summary,
      messageCount: recentMessages.length,
      totalTokenEstimate: remainingTokens,
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// patchThreadAfterCompaction (helper mutation for compactThread)
// ---------------------------------------------------------------------------

export const patchThreadAfterCompaction = internalMutation({
  args: {
    threadId: v.id("threads"),
    summary: v.string(),
    messageCount: v.number(),
    totalTokenEstimate: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, {
      summary: args.summary,
      messageCount: args.messageCount,
      totalTokenEstimate: args.totalTokenEstimate,
    });
    return null;
  },
});
