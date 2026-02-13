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
import { THREAD_COMPACTION_KEEP_RECENT_TOKENS } from "../agent/context_budget";
import {
  findThreadCompactionCutByTokens,
  formatThreadMessagesForCompaction,
} from "./thread_compaction_format";

const MAX_THREADS_PER_CONVERSATION = 16;
const MAX_CONTENT_LENGTH = 500_000;
const MIN_MESSAGES_FOR_COMPACTION = 6;
const THREAD_SWEEP_BATCH_SIZE = 200;

export const THREAD_IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

type ThreadLifecycleStatus = "active" | "idle" | "archived";

const normalizeLifecycleStatus = (status: string): ThreadLifecycleStatus =>
  status === "idle" || status === "archived" ? status : "active";

const threadStatusRank = (status: string): number => {
  switch (normalizeLifecycleStatus(status)) {
    case "active":
      return 0;
    case "idle":
      return 1;
    case "archived":
      return 2;
  }
};

export const deriveThreadLifecycleStatus = (args: {
  status: string;
  lastUsedAt: number;
  now: number;
  idleAfterMs?: number;
  archiveAfterMs?: number;
}): ThreadLifecycleStatus => {
  const idleAfterMs = args.idleAfterMs ?? THREAD_IDLE_AFTER_MS;
  const archiveAfterMs = args.archiveAfterMs ?? THREAD_ARCHIVE_AFTER_MS;
  const current = normalizeLifecycleStatus(args.status);

  if (current === "archived") {
    return "archived";
  }
  if (args.now - args.lastUsedAt >= archiveAfterMs) {
    return "archived";
  }
  if (args.now - args.lastUsedAt >= idleAfterMs) {
    return "idle";
  }
  return "active";
};

const THREAD_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints, preferences, or requirements]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next step]

## Critical Context
- [Important paths, function names, errors, details needed to continue]

Keep sections concise. Preserve exact file paths, function names, and error messages.`;

const THREAD_COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary in <previous-summary>.

Update the existing structured summary with new information:
- Preserve prior important context unless superseded
- Move completed items from In Progress to Done
- Add new decisions, errors, and outcomes
- Update Next Steps based on the latest state
- Preserve exact file paths, function names, and error messages

Use the same exact output format as the base summary prompt.`;

const TURN_PREFIX_SUMMARY_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize only what is needed for continuity:

## Original Request
[What the user asked in this turn]

## Early Progress
- [Decisions and work completed in this prefix]

## Context for Suffix
- [Information needed to understand the retained suffix]

Be concise and preserve exact technical details.`;

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
  resurfacedAt: v.optional(v.number()),
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
          status: "archived",
          closedAt: Date.now(),
        });
      }
    }

    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      conversationId: args.conversationId,
      name: args.name,
      status: "active",
      messageCount: 0,
      totalTokenEstimate: 0,
      createdAt: now,
      lastUsedAt: now,
    });

    const conversation = await ctx.db.get(args.conversationId);
    if (conversation) {
      await ctx.scheduler.runAfter(0, internal.data.memory_architecture.extractConversationWindow, {
        conversationId: args.conversationId,
        ownerId: conversation.ownerId,
        trigger: "new_thread",
        windowEnd: now,
      });
    }

    return threadId;
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
    const matches = await ctx.db
      .query("threads")
      .withIndex("by_conversation_name", (q) =>
        q.eq("conversationId", args.conversationId).eq("name", args.name),
      )
      .collect();

    if (matches.length === 0) {
      return null;
    }

    matches.sort(
      (a, b) =>
        threadStatusRank(a.status) - threadStatusRank(b.status) ||
        b.lastUsedAt - a.lastUsedAt ||
        String(a._id).localeCompare(String(b._id)),
    );

    return matches[0] ?? null;
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
    const now = Date.now();
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;

    await ctx.db.patch(args.threadId, {
      lastUsedAt: now,
      ...(thread.status !== "active"
        ? {
            status: "active",
            resurfacedAt: now,
          }
        : {}),
    });
    return null;
  },
});

export const activateThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.union(threadValidator, v.null()),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      lastUsedAt: now,
      ...(thread.status !== "active"
        ? {
            status: "active",
            resurfacedAt: now,
          }
        : {}),
    });

    return await ctx.db.get(args.threadId);
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
      status: "archived",
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
      ...(thread.status !== "active"
        ? {
            status: "active",
            resurfacedAt: now,
          }
        : {}),
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
        status: "archived",
        closedAt: Date.now(),
      });
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// compactThread (internal action - uses LLM to summarize old messages)
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

    // 4. Split by token budget. If a turn is split, summarize the dropped prefix separately.
    const cut = findThreadCompactionCutByTokens(
      messages,
      THREAD_COMPACTION_KEEP_RECENT_TOKENS,
    );
    const oldMessages = messages.slice(0, cut.historyEndIndex);
    const turnPrefixMessages = cut.isSplitTurn
      ? messages.slice(cut.turnStartIndex, cut.recentStartIndex)
      : [];
    const recentMessages = messages.slice(cut.recentStartIndex);

    if (oldMessages.length === 0 && turnPrefixMessages.length === 0) return null;

    // 5. Format old messages for summarization (tool-aware, role-aware).
    const oldText = formatThreadMessagesForCompaction(
      oldMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    );

    // 6. Call LLM to summarize or incrementally update.
    const hasPreviousSummary = Boolean(thread.summary && thread.summary.trim().length > 0);
    const config = getModelConfig("memory_ops");

    let baseSummary = hasPreviousSummary ? thread.summary!.trim() : "";
    if (oldText.trim().length > 0) {
      const promptBody = [
        `<conversation>\n${oldText}\n</conversation>`,
        hasPreviousSummary ? `<previous-summary>\n${thread.summary!.trim()}\n</previous-summary>` : "",
        hasPreviousSummary ? THREAD_COMPACTION_UPDATE_PROMPT : THREAD_COMPACTION_PROMPT,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");

      const { text: nextSummaryText } = await generateText({
        ...config,
        system: "Output ONLY the summary content.",
        messages: [
          {
            role: "user",
            content: promptBody,
          },
        ],
      });
      baseSummary = nextSummaryText.trim();
    }

    let turnPrefixSummary = "";
    if (turnPrefixMessages.length > 0) {
      const turnPrefixText = formatThreadMessagesForCompaction(
        turnPrefixMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      );
      if (turnPrefixText.trim().length > 0) {
        const { text: turnPrefixSummaryText } = await generateText({
          ...config,
          system: "Output ONLY the summary content.",
          messages: [
            {
              role: "user",
              content: `<conversation>\n${turnPrefixText}\n</conversation>\n\n${TURN_PREFIX_SUMMARY_PROMPT}`,
            },
          ],
        });
        turnPrefixSummary = turnPrefixSummaryText.trim();
      }
    }

    const summary = [baseSummary, turnPrefixSummary ? `---\n\n${turnPrefixSummary}` : ""]
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
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

    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: thread.conversationId,
    });
    if (conversation) {
      const windowEnd = oldMessages[oldMessages.length - 1]?.createdAt ?? Date.now();
      await ctx.scheduler.runAfter(0, internal.data.memory_architecture.extractThreadCompactionWindow, {
        conversationId: thread.conversationId,
        ownerId: conversation.ownerId,
        windowEnd,
        events: oldMessages.map((message) => ({
          type: `thread_${message.role}`,
          text: message.content,
          timestamp: message.createdAt,
        })),
      });
    }

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
      lastUsedAt: Date.now(),
    });
    return null;
  },
});

export const sweepThreadLifecycle = internalMutation({
  args: {
    now: v.optional(v.number()),
  },
  returns: v.object({
    idled: v.number(),
    archived: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const idleCutoff = now - THREAD_IDLE_AFTER_MS;
    const archiveCutoff = now - THREAD_ARCHIVE_AFTER_MS;

    const activeCandidates = await ctx.db
      .query("threads")
      .withIndex("by_status_last_used", (q) =>
        q.eq("status", "active").lt("lastUsedAt", idleCutoff),
      )
      .take(THREAD_SWEEP_BATCH_SIZE);

    let idled = 0;
    for (const thread of activeCandidates) {
      const nextStatus = deriveThreadLifecycleStatus({
        status: thread.status,
        lastUsedAt: thread.lastUsedAt,
        now,
      });
      if (nextStatus === "idle") {
        await ctx.db.patch(thread._id, { status: "idle" });
        idled += 1;
      } else if (nextStatus === "archived") {
        await ctx.db.patch(thread._id, {
          status: "archived",
          closedAt: now,
        });
      }
    }

    const idleCandidates = await ctx.db
      .query("threads")
      .withIndex("by_status_last_used", (q) =>
        q.eq("status", "idle").lt("lastUsedAt", archiveCutoff),
      )
      .take(THREAD_SWEEP_BATCH_SIZE);

    let archived = 0;
    for (const thread of idleCandidates) {
      const nextStatus = deriveThreadLifecycleStatus({
        status: thread.status,
        lastUsedAt: thread.lastUsedAt,
        now,
      });
      if (nextStatus === "archived") {
        await ctx.db.patch(thread._id, {
          status: "archived",
          closedAt: now,
        });
        archived += 1;
      }
    }

    return { idled, archived };
  },
});

