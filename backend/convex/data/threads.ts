import { ConvexError, v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { generateText } from "ai";
import { getModelConfig } from "../agent/model";
import {
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
  SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS,
  THREAD_COMPACTION_KEEP_RECENT_TOKENS,
} from "../agent/context_budget";
import {
  findThreadCompactionCutByTokens,
  formatThreadMessagesForCompaction,
} from "./thread_compaction_format";

const MAX_THREADS_PER_CONVERSATION = 16;
const MAX_CONTENT_LENGTH = 500_000;
const MIN_MESSAGES_FOR_COMPACTION = 6;
const THREAD_SWEEP_BATCH_SIZE = 200;
const THREAD_COMPACTION_MAX_RETRIES = 2;

export const THREAD_IDLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const loadConversationForOwner = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
  ownerId: string,
) => {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    return null;
  }
  return conversation;
};

const loadThreadForOwner = async (
  ctx: QueryCtx | MutationCtx,
  threadId: Id<"threads">,
  ownerId: string,
) => {
  const thread = await ctx.db.get(threadId);
  if (!thread) {
    return null;
  }
  const conversation = await loadConversationForOwner(ctx, thread.conversationId, ownerId);
  if (!conversation) {
    return null;
  }
  return thread;
};

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

When summarizing coding sessions:
- Focus on test output and code changes.
- Preserve exact file paths, function names, and error messages.
- Include critical file-read snippets verbatim when needed for continuity.

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

Keep sections concise. Preserve exact technical details needed to resume work.`;

const THREAD_COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary in <previous-summary>.

Update the existing structured summary with new information:
- Preserve prior important context unless superseded
- Move completed items from In Progress to Done
- Add new decisions, errors, and outcomes
- Update Next Steps based on the latest state
- Preserve exact file paths, function names, and error messages
- Carry forward critical file-read snippets verbatim when still relevant

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

const generateCompactionTextWithRetry = async (
  config: ReturnType<typeof getModelConfig>,
  promptBody: string,
): Promise<string> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= THREAD_COMPACTION_MAX_RETRIES; attempt += 1) {
    try {
      const { text } = await generateText({
        ...config,
        system: "Output ONLY the summary content.",
        messages: [
          {
            role: "user",
            content: promptBody,
          },
        ],
      });
      return text.trim();
    } catch (error) {
      lastError = error;
      if (attempt >= THREAD_COMPACTION_MAX_RETRIES) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("Compaction summary generation failed");
};

// ---------------------------------------------------------------------------
// Truncate large content to prevent DB bloat
// ---------------------------------------------------------------------------

const truncateContent = (raw: string): string => {
  if (raw.length > MAX_CONTENT_LENGTH) {
    return raw.slice(0, MAX_CONTENT_LENGTH) + '"...[truncated]"';
  }
  return raw;
};

const activeThreadStatePatch = (thread: { status: string }, now: number) => ({
  lastUsedAt: now,
  ...(thread.status !== "active"
    ? {
        status: "active" as const,
        resurfacedAt: now,
      }
    : {}),
});

// ---------------------------------------------------------------------------
// createThread
// ---------------------------------------------------------------------------

export const createThread = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Conversation not found",
      });
    }

    // Check active thread count and evict if at limit
    const activeThreads = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_status_and_lastUsedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    let evictedThreadName: string | null = null;
    if (activeThreads.length >= MAX_THREADS_PER_CONVERSATION) {
      // Evict the oldest (least recently used)
      const sorted = activeThreads.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const oldest = sorted[0];
      if (oldest) {
        evictedThreadName = oldest.name;
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

    return { threadId, evictedThreadName };
  },
});

// ---------------------------------------------------------------------------
// getThreadByName
// ---------------------------------------------------------------------------

export const getThreadByName = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      return null;
    }

    const matches = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_name", (q) =>
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

    return matches[0];
  },
});

// ---------------------------------------------------------------------------
// getThreadById
// ---------------------------------------------------------------------------

export const getThreadById = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.threadId);
  },
});

// ---------------------------------------------------------------------------
// listActiveThreads
// ---------------------------------------------------------------------------

export const listActiveThreads = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await loadConversationForOwner(
      ctx,
      args.conversationId,
      args.ownerId,
    );
    if (!conversation) {
      return [];
    }

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_status_and_lastUsedAt", (q) =>
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
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;

    await ctx.db.patch(args.threadId, activeThreadStatePatch(thread, now));
    return null;
  },
});

export const activateThread = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) {
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(args.threadId, activeThreadStatePatch(thread, now));

    return await ctx.db.get(args.threadId);
  },
});

// ---------------------------------------------------------------------------
// closeThread
// ---------------------------------------------------------------------------

export const closeThread = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;
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
  handler: async (ctx, args) => {
    return await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
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
    ownerId: v.string(),
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
  handler: async (ctx, args) => {
    if (args.messages.length === 0) return null;

    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return null;

    // Get the current max ordinal
    const lastMessage = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
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
      ...activeThreadStatePatch(thread, now),
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// deleteMessagesBefore
// ---------------------------------------------------------------------------

export const deleteMessagesBefore = internalMutation({
  args: {
    ownerId: v.string(),
    threadId: v.id("threads"),
    beforeOrdinal: v.number(),
  },
  handler: async (ctx, args) => {
    const thread = await loadThreadForOwner(ctx, args.threadId, args.ownerId);
    if (!thread) return 0;

    const messages = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) =>
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
// compactThread (internal action - uses LLM to summarize old messages)
// ---------------------------------------------------------------------------

export const compactThread = internalAction({
  args: {
    threadId: v.id("threads"),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // 1. Load thread metadata
    const thread = await ctx.runQuery(internal.data.threads.getThreadById, {
      threadId: args.threadId,
    });
    if (!thread || thread.status !== "active") return null;
    const triggerTokens = thread.name === "Main"
      ? ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
      : SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS;
    if (!args.force && thread.totalTokenEstimate < triggerTokens) {
      return null;
    }

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
      oldMessages.map((m: { role: string; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
    );

    // 6. Call LLM to summarize or incrementally update.
    const hasPreviousSummary = Boolean(thread.summary && thread.summary.trim().length > 0);
    const config = getModelConfig("thread_compaction_summary");

    let baseSummary = hasPreviousSummary ? thread.summary!.trim() : "";
    if (oldText.trim().length > 0) {
      const promptBody = [
        `<conversation>\n${oldText}\n</conversation>`,
        hasPreviousSummary ? `<previous-summary>\n${thread.summary!.trim()}\n</previous-summary>` : "",
        hasPreviousSummary ? THREAD_COMPACTION_UPDATE_PROMPT : THREAD_COMPACTION_PROMPT,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n");

      baseSummary = await generateCompactionTextWithRetry(config, promptBody);
    }

    let turnPrefixSummary = "";
    if (turnPrefixMessages.length > 0) {
      const turnPrefixText = formatThreadMessagesForCompaction(
        turnPrefixMessages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
      );
      if (turnPrefixText.trim().length > 0) {
        turnPrefixSummary = await generateCompactionTextWithRetry(
          config,
          `<conversation>\n${turnPrefixText}\n</conversation>\n\n${TURN_PREFIX_SUMMARY_PROMPT}`,
        );
      }
    }

    const summary = [baseSummary, turnPrefixSummary ? `---\n\n${turnPrefixSummary}` : ""]
      .filter((part) => part.trim().length > 0)
      .join("\n\n")
      .trim();
    if (summary.length === 0) return null;

    // 7. Apply the compaction result in one mutation transaction.
    const firstRecentOrdinal = recentMessages[0].ordinal;
    await ctx.runMutation(internal.data.threads.finalizeThreadCompaction, {
      threadId: args.threadId,
      keepFromOrdinal: firstRecentOrdinal,
      summary,
    });

    return null;
  },
});

export const finalizeThreadCompaction = internalMutation({
  args: {
    threadId: v.id("threads"),
    keepFromOrdinal: v.number(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.status !== "active") {
      return null;
    }

    const allMessages = await ctx.db
      .query("thread_messages")
      .withIndex("by_threadId_and_ordinal", (q) => q.eq("threadId", args.threadId))
      .collect();
    const dropped = allMessages.filter((msg) => msg.ordinal < args.keepFromOrdinal);
    const retained = allMessages
      .filter((msg) => msg.ordinal >= args.keepFromOrdinal)
      .sort((a, b) => a.ordinal - b.ordinal);
    for (const msg of dropped) {
      await ctx.db.delete(msg._id);
    }

    const remainingTokens = retained.reduce(
      (sum, msg) => sum + (msg.tokenEstimate ?? 0),
      0,
    );
    const remainingCount = retained.length;

    if (thread.name !== "Main") {
      await ctx.db.patch(args.threadId, {
        summary: args.summary,
        messageCount: remainingCount,
        totalTokenEstimate: remainingTokens,
        lastUsedAt: now,
      });
      return null;
    }

    const conversation = await ctx.db.get(thread.conversationId);
    if (!conversation || conversation.activeThreadId !== args.threadId) {
      await ctx.db.patch(args.threadId, {
        summary: args.summary,
        messageCount: remainingCount,
        totalTokenEstimate: remainingTokens,
        lastUsedAt: now,
      });
      return null;
    }

    const rolloverThreadId = await ctx.db.insert("threads", {
      conversationId: thread.conversationId,
      name: "Main",
      status: "active",
      summary: args.summary,
      messageCount: remainingCount,
      totalTokenEstimate: remainingTokens,
      createdAt: now,
      lastUsedAt: now,
    });

    let nextOrdinal = 0;
    for (const msg of retained) {
      await ctx.db.insert("thread_messages", {
        threadId: rolloverThreadId,
        ordinal: nextOrdinal,
        role: msg.role,
        content: msg.content,
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(typeof msg.tokenEstimate === "number"
          ? { tokenEstimate: msg.tokenEstimate }
          : {}),
        createdAt: msg.createdAt ?? now,
      });
      nextOrdinal += 1;
      await ctx.db.delete(msg._id);
    }

    await ctx.db.patch(args.threadId, {
      summary: args.summary,
      messageCount: 0,
      totalTokenEstimate: 0,
      status: "archived",
      closedAt: now,
      lastUsedAt: now,
    });

    await ctx.db.patch(thread.conversationId, {
      activeThreadId: rolloverThreadId,
      forceReminderOnNextTurn: true,
      updatedAt: now,
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
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const idleCutoff = now - THREAD_IDLE_AFTER_MS;
    const archiveCutoff = now - THREAD_ARCHIVE_AFTER_MS;

    const activeCandidates = await ctx.db
      .query("threads")
      .withIndex("by_status_and_lastUsedAt", (q) =>
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
      .withIndex("by_status_and_lastUsedAt", (q) =>
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
