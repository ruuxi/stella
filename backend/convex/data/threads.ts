import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { generateText } from "ai";
import { resolveModelConfig } from "../agent/model_resolver";
import { requireConversationOwner } from "../auth";

const MAX_ACTIVE_THREADS = 8;

// ---------------------------------------------------------------------------
// createThread (internal mutation)
// ---------------------------------------------------------------------------

export const createThread = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    agentType: v.string(),
    title: v.string(),
    ownerId: v.string(),
  },
  returns: v.id("threads"),
  handler: async (ctx, args) => {
    // Check active thread count and archive oldest if at cap
    const activeThreads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    if (activeThreads.length >= MAX_ACTIVE_THREADS) {
      // Find oldest by lastActiveAt
      const sorted = activeThreads.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      const oldest = sorted[0];
      // Mark as archived — summarization happens async
      await ctx.db.patch(oldest._id, { status: "archived" });
      await ctx.scheduler.runAfter(0, internal.data.threads.archiveAndSummarize, {
        threadId: oldest._id,
        ownerId: args.ownerId,
      });
    }

    const now = Date.now();
    return await ctx.db.insert("threads", {
      conversationId: args.conversationId,
      agentType: args.agentType,
      title: args.title,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
    });
  },
});

// ---------------------------------------------------------------------------
// listActiveThreads (internal query)
// ---------------------------------------------------------------------------

export const listActiveThreads = internalQuery({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(
    v.object({
      _id: v.id("threads"),
      agentType: v.string(),
      title: v.string(),
      lastActiveAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    // Sort by lastActiveAt desc (most recent first)
    threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return threads.map((t) => ({
      _id: t._id,
      agentType: t.agentType,
      title: t.title,
      lastActiveAt: t.lastActiveAt,
    }));
  },
});

export const listActiveThreadsForConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.array(
    v.object({
      _id: v.id("threads"),
      agentType: v.string(),
      title: v.string(),
      status: v.string(),
      createdAt: v.number(),
      lastActiveAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    return threads.map((thread) => ({
      _id: thread._id,
      agentType: thread.agentType,
      title: thread.title,
      status: thread.status,
      createdAt: thread.createdAt,
      lastActiveAt: thread.lastActiveAt,
    }));
  },
});

export const getActiveThreadsHeadForConversation = query({
  args: {
    conversationId: v.id("conversations"),
  },
  returns: v.object({
    activeCount: v.number(),
    latestLastActiveAt: v.number(),
    latestThreadId: v.union(v.id("threads"), v.null()),
  }),
  handler: async (ctx, args) => {
    await requireConversationOwner(ctx, args.conversationId);
    const activeThreads = await ctx.db
      .query("threads")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "active"),
      )
      .collect();

    let latestLastActiveAt = 0;
    let latestThreadId: Id<"threads"> | null = null;
    for (const thread of activeThreads) {
      if (thread.lastActiveAt > latestLastActiveAt) {
        latestLastActiveAt = thread.lastActiveAt;
        latestThreadId = thread._id;
      }
    }

    return {
      activeCount: activeThreads.length,
      latestLastActiveAt,
      latestThreadId,
    };
  },
});

// ---------------------------------------------------------------------------
// touchThread (internal mutation)
// ---------------------------------------------------------------------------

export const touchThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, {
      lastActiveAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// appendStep (internal mutation)
// ---------------------------------------------------------------------------

export const appendStep = internalMutation({
  args: {
    threadId: v.id("threads"),
    stepIndex: v.number(),
    prompt: v.string(),
    response: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("thread_messages", {
      threadId: args.threadId,
      stepIndex: args.stepIndex,
      prompt: args.prompt,
      response: args.response,
      createdAt: Date.now(),
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// loadSteps (internal query)
// ---------------------------------------------------------------------------

export const loadSteps = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.array(
    v.object({
      stepIndex: v.number(),
      prompt: v.string(),
      response: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const steps = await ctx.db
      .query("thread_messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    return steps.map((s) => ({
      stepIndex: s.stepIndex,
      prompt: s.prompt,
      response: s.response,
    }));
  },
});

// ---------------------------------------------------------------------------
// archiveThread (internal mutation)
// ---------------------------------------------------------------------------

export const archiveThread = internalMutation({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, { status: "archived" });
    return null;
  },
});

// ---------------------------------------------------------------------------
// getThread (internal query)
// ---------------------------------------------------------------------------

export const getThread = internalQuery({
  args: {
    threadId: v.id("threads"),
  },
  returns: v.union(
    v.object({
      _id: v.id("threads"),
      conversationId: v.id("conversations"),
      agentType: v.string(),
      title: v.string(),
      status: v.string(),
      createdAt: v.number(),
      lastActiveAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;
    return {
      _id: thread._id,
      conversationId: thread.conversationId,
      agentType: thread.agentType,
      title: thread.title,
      status: thread.status,
      createdAt: thread.createdAt,
      lastActiveAt: thread.lastActiveAt,
    };
  },
});

// ---------------------------------------------------------------------------
// archiveAndSummarize (internal action) — summarize thread → episodic memory
// ---------------------------------------------------------------------------

const extractLastAssistantText = (responseJson: string): string => {
  try {
    const messages = JSON.parse(responseJson);
    if (!Array.isArray(messages)) return "(no response)";
    // Find last assistant message with text content
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") return msg.content;
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(
            (p: { type: string; text?: string }) => p.type === "text" && p.text,
          );
          if (textPart) return textPart.text;
        }
      }
    }
    return "(no response)";
  } catch {
    return "(parse error)";
  }
};

export const archiveAndSummarize = internalAction({
  args: {
    threadId: v.id("threads"),
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.runQuery(internal.data.threads.getThread, {
      threadId: args.threadId,
    });
    if (!thread) return null;

    const steps = await ctx.runQuery(internal.data.threads.loadSteps, {
      threadId: args.threadId,
    });

    if (steps.length === 0) return null;

    // Build summary text from prompts + final result of each step
    const summaryText = steps
      .map(
        (s) =>
          `Task: ${s.prompt}\nOutcome: ${extractLastAssistantText(s.response)}`,
      )
      .join("\n\n");

    // Truncate to avoid token limits on cheap model
    const truncated = summaryText.slice(0, 4000);

    try {
      const resolvedConfig = await resolveModelConfig(ctx, "memory_ops", args.ownerId);
      const { text: summary } = await generateText({
        ...resolvedConfig,
        prompt: `Summarize this work session titled "${thread.title}" into 2-3 sentences of key facts and outcomes:\n\n${truncated}`,
      });

      // Insert as episodic memory
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        category: "threads",
        subcategory: thread.title,
        content: summary,
      });
    } catch (err) {
      console.error("[threads] archiveAndSummarize failed:", err);
    }

    return null;
  },
});
