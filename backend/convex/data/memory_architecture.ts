import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { embed } from "ai";
import { getModelConfig } from "../agent/model";

const TOKEN_FALLBACK_THRESHOLD = 20_000;
const MAX_MEMORIES_PER_OWNER = 500;
const DEDUP_THRESHOLD = 0.9;

export const MEMORY_ARCHITECTURE_CONSTANTS = {
  TOKEN_FALLBACK_THRESHOLD,
  MAX_MEMORIES_PER_OWNER,
} as const;

const memoryValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  content: v.string(),
  embedding: v.optional(v.array(v.float64())),
  accessedAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
});

const extractionSnapshotValidator = v.object({
  content: v.string(),
  memoryId: v.optional(v.id("memories")),
});

const extractionBatchValidator = v.object({
  _id: v.id("memory_extraction_batches"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  trigger: v.string(),
  windowStart: v.number(),
  windowEnd: v.number(),
  snapshot: v.array(extractionSnapshotValidator),
  createdAt: v.number(),
});

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function embedText(text: string): Promise<number[]> {
  const config = getModelConfig("embedding");
  const { embedding: vector } = await embed({
    ...config,
    value: text,
  });
  return vector;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getTokenFallbackThreshold = internalQuery({
  args: {},
  returns: v.number(),
  handler: async () => TOKEN_FALLBACK_THRESHOLD,
});

export const getLatestExtractionBatch = internalQuery({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.union(extractionBatchValidator, v.null()),
  handler: async (ctx, args) => {
    if (args.conversationId) {
      return await ctx.db
        .query("memory_extraction_batches")
        .withIndex("by_ownerId_and_conversationId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("conversationId", args.conversationId),
        )
        .order("desc")
        .first();
    }

    return await ctx.db
      .query("memory_extraction_batches")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .first();
  },
});

export const insertExtractionBatch = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    trigger: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    snapshot: v.array(extractionSnapshotValidator),
  },
  returns: v.id("memory_extraction_batches"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("memory_extraction_batches", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      trigger: args.trigger,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      snapshot: args.snapshot,
      createdAt: Date.now(),
    });
  },
});

export const listOwnerMemories = internalQuery({
  args: {
    ownerId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(memoryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 3000), 1), 10_000);
    return await ctx.db
      .query("memories")
      .withIndex("by_ownerId_and_accessedAt", (q) => q.eq("ownerId", args.ownerId))
      .take(limit);
  },
});

export const listOldestOwnerMemories = internalQuery({
  args: {
    ownerId: v.string(),
    limit: v.number(),
  },
  returns: v.array(memoryValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 1000);
    return await ctx.db
      .query("memories")
      .withIndex("by_ownerId_and_accessedAt", (q) => q.eq("ownerId", args.ownerId))
      .order("asc")
      .take(limit);
  },
});

// ---------------------------------------------------------------------------
// ingestExtractionWindow — extract facts → embed → dedup → insert
// ---------------------------------------------------------------------------

export const ingestExtractionWindow = internalAction({
  args: {
    conversationId: v.optional(v.id("conversations")),
    ownerId: v.string(),
    trigger: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    events: v.array(v.object({
      type: v.string(),
      text: v.string(),
      timestamp: v.optional(v.number()),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const filtered = args.events.filter((event) => {
      if (!event.text.trim()) return false;
      if (typeof event.timestamp !== "number") return true;
      return event.timestamp > args.windowStart && event.timestamp <= args.windowEnd;
    });

    const summary = filtered
      .map((event) => {
        const ts = typeof event.timestamp === "number" ? ` @${event.timestamp}` : "";
        return `[${event.type}${ts}] ${event.text}`;
      })
      .join("\n\n");

    const advanceCursor = async () => {
      if (!args.conversationId) return;

      const conversation = await ctx.runQuery(internal.conversations.getById, {
        id: args.conversationId,
      });

      await ctx.runMutation(internal.conversations.patchLastIngestedAt, {
        conversationId: args.conversationId,
        lastIngestedAt: args.windowEnd,
      });

      await ctx.runMutation(internal.conversations.patchExtractionCursor, {
        conversationId: args.conversationId,
        lastExtractionAt: args.windowEnd,
        lastExtractionTokenCount:
          conversation?.tokenCount ?? conversation?.lastExtractionTokenCount ?? 0,
      });
    };

    if (!summary.trim()) {
      await advanceCursor();
      return null;
    }

    const extracted = await ctx.runAction(internal.data.memory.extractFacts, {
      summary,
    });

    const touchedIds = new Set<Id<"memories">>();

    if (extracted.parseOk) {
      for (const fact of extracted.facts) {
        try {
          const vector = await embedText(fact.content);
          const similar = await ctx.vectorSearch("memories", "by_embedding", {
            vector,
            limit: 3,
            filter: (q) => q.eq("ownerId", args.ownerId),
          });

          if (similar.length > 0 && similar[0]._score > DEDUP_THRESHOLD) {
            await ctx.runMutation(internal.data.memory.touchMemoriesById, {
              memoryIds: [similar[0]._id],
            });
            touchedIds.add(similar[0]._id);
            continue;
          }

          const memoryId = await ctx.runMutation(internal.data.memory.insertMemory, {
            ownerId: args.ownerId,
            conversationId: args.conversationId,
            content: fact.content,
            embedding: vector,
          });
          touchedIds.add(memoryId);
        } catch (err) {
          console.error("[memory_architecture] ingestExtractionWindow: error processing fact", err);
        }
      }
    }

    // Build snapshot from touched memories
    const snapshot: Array<{ content: string; memoryId?: Id<"memories"> }> = [];
    for (const memoryId of touchedIds) {
      const memory = await ctx.runQuery(internal.data.memory.getMemoryById, {
        id: memoryId,
      });
      if (!memory) continue;
      snapshot.push({
        content: memory.content,
        memoryId: memory._id,
      });
    }

    await ctx.runMutation(internal.data.memory_architecture.insertExtractionBatch, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      trigger: args.trigger,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      snapshot,
    });

    await ctx.runAction(internal.data.memory_architecture.enforceGrowthLimitsForOwner, {
      ownerId: args.ownerId,
    });

    await advanceCursor();
    return null;
  },
});

export const extractConversationWindow = internalAction({
  args: {
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    trigger: v.string(),
    windowEnd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });
    if (!conversation || conversation.ownerId !== args.ownerId) {
      return null;
    }

    const windowStart = conversation.lastExtractionAt ?? conversation.lastIngestedAt ?? 0;
    const windowEnd = Math.max(windowStart, args.windowEnd ?? Date.now());
    if (windowEnd <= windowStart) {
      return null;
    }

    const events = await ctx.runQuery(internal.events.listMessagesInWindow, {
      conversationId: args.conversationId,
      startTimestamp: windowStart,
      endTimestamp: windowEnd,
      limit: 1500,
    });

    await ctx.runAction(internal.data.memory_architecture.ingestExtractionWindow, {
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      trigger: args.trigger,
      windowStart,
      windowEnd,
      events: events.map((event: { type: string; timestamp: number; payload: unknown }) => ({
        type: event.type,
        timestamp: event.timestamp,
        text: (() => {
          const payload =
            event.payload && typeof event.payload === "object"
              ? (event.payload as { text?: unknown; result?: unknown })
              : {};
          if (typeof payload.text === "string" && payload.text.trim().length > 0) {
            return payload.text;
          }
          if (event.type === "task_completed" && payload.result !== undefined) {
            if (typeof payload.result === "string") {
              return payload.result;
            }
            try {
              return JSON.stringify(payload.result);
            } catch {
              return String(payload.result);
            }
          }
          return "";
        })(),
      })),
    });

    return null;
  },
});

export const extractThreadCompactionWindow = internalAction({
  args: {
    conversationId: v.id("conversations"),
    ownerId: v.string(),
    windowEnd: v.number(),
    events: v.array(v.object({
      type: v.string(),
      text: v.string(),
      timestamp: v.optional(v.number()),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      id: args.conversationId,
    });
    if (!conversation || conversation.ownerId !== args.ownerId) {
      return null;
    }

    const windowStart = conversation.lastExtractionAt ?? conversation.lastIngestedAt ?? 0;
    const windowEnd = Math.max(windowStart, args.windowEnd);
    if (windowEnd <= windowStart) {
      return null;
    }

    await ctx.runAction(internal.data.memory_architecture.ingestExtractionWindow, {
      conversationId: args.conversationId,
      ownerId: args.ownerId,
      trigger: "thread_compaction",
      windowStart,
      windowEnd,
      events: args.events,
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// enforceGrowthLimitsForOwner — delete least-accessed if over limit
// ---------------------------------------------------------------------------

export const enforceGrowthLimitsForOwner = internalAction({
  args: {
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memories = await ctx.runQuery(internal.data.memory_architecture.listOwnerMemories, {
      ownerId: args.ownerId,
      limit: 3000,
    });

    if (memories.length > MAX_MEMORIES_PER_OWNER) {
      const overflow = memories.length - MAX_MEMORIES_PER_OWNER;
      const oldest = await ctx.runQuery(internal.data.memory_architecture.listOldestOwnerMemories, {
        ownerId: args.ownerId,
        limit: overflow,
      });
      for (const memory of oldest) {
        await ctx.runMutation(internal.data.memory.deleteMemory, {
          memoryId: memory._id,
        });
      }
    }

    return null;
  },
});

export const listDistinctMemoryOwners = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 500, 2000);
    const memories = await ctx.db
      .query("memories")
      .withIndex("by_accessedAt")
      .take(limit);
    return Array.from(new Set(memories.map((m) => m.ownerId)));
  },
});
