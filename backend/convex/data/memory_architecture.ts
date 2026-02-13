import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { generateText } from "ai";
import { getModelConfig } from "../agent/model";

const TOKEN_FALLBACK_THRESHOLD = 20_000;
const MAX_MEMORIES_PER_OWNER = 500;
const MAX_MEMORIES_PER_SUBCATEGORY = 30;
const WEEKLY_CONSOLIDATION_THRESHOLD = 12;

export const MEMORY_ARCHITECTURE_CONSTANTS = {
  TOKEN_FALLBACK_THRESHOLD,
  MAX_MEMORIES_PER_OWNER,
  MAX_MEMORIES_PER_SUBCATEGORY,
  WEEKLY_CONSOLIDATION_THRESHOLD,
} as const;

const memoryValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  category: v.string(),
  subcategory: v.string(),
  content: v.string(),
  accessedAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
  decay: v.number(),
});

const extractionSnapshotValidator = v.object({
  category: v.string(),
  subcategory: v.string(),
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

const DEDUP_PROMPT = `Compare a new fact against existing memories in the same subcategory. Decide:
- INSERT: new information not captured by existing memories
- SKIP: already captured by an existing memory
- MERGE: overlaps with an existing memory; provide merged content

Output valid JSON:
{"action":"INSERT"|"SKIP"|"MERGE","content":"...merged content if MERGE, else empty","mergeTargetIndex":0}

mergeTargetIndex is the 0-based index of the existing memory to merge with (only for MERGE).
Output ONLY the JSON, nothing else.`;

const DIFF_PROMPT = `You compare previous extracted memory rows with new conversation content.
Return ONLY JSON:
{"updates":[{"index":0,"content":"updated text"}],"deletes":[{"index":1}]}
If no changes are needed, return {"updates":[],"deletes":[]}.`;

const CONSOLIDATE_PROMPT = `Consolidate these memory rows from one category/subcategory into one canonical memory.
Prefer most recent facts when contradictions exist.
Output ONLY the consolidated memory text.`;

async function cheapLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const config = getModelConfig("memory_ops");
  const { text } = await generateText({
    ...config,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return text;
}

const extractJsonObject = (value: string): string | null => {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
};

type DiffDecision = {
  updates: Array<{ index: number; content: string }>;
  deletes: Array<{ index: number }>;
};

export const parseDiffDecision = (value: string): DiffDecision => {
  const parse = (raw: string): DiffDecision | null => {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const updates = Array.isArray(parsed.updates)
        ? parsed.updates
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const row = item as Record<string, unknown>;
              if (typeof row.index !== "number" || typeof row.content !== "string") return null;
              const content = row.content.trim();
              if (!content) return null;
              return { index: Math.floor(row.index), content };
            })
            .filter((item): item is { index: number; content: string } => item !== null)
        : [];
      const deletes = Array.isArray(parsed.deletes)
        ? parsed.deletes
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const row = item as Record<string, unknown>;
              if (typeof row.index !== "number") return null;
              return { index: Math.floor(row.index) };
            })
            .filter((item): item is { index: number } => item !== null)
        : [];
      return { updates, deletes };
    } catch {
      return null;
    }
  };

  const direct = parse(value.trim());
  if (direct) return direct;
  const block = extractJsonObject(value);
  if (block) {
    const parsed = parse(block);
    if (parsed) return parsed;
  }
  return { updates: [], deletes: [] };
};

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
        .withIndex("by_owner_conversation_created", (q) =>
          q.eq("ownerId", args.ownerId).eq("conversationId", args.conversationId),
        )
        .order("desc")
        .first();
    }

    return await ctx.db
      .query("memory_extraction_batches")
      .withIndex("by_owner_created", (q) => q.eq("ownerId", args.ownerId))
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
      .withIndex("by_owner_category", (q) => q.eq("ownerId", args.ownerId))
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
      .withIndex("by_owner_accessed", (q) => q.eq("ownerId", args.ownerId))
      .order("asc")
      .take(limit);
  },
});


const consolidateSubcategory = async (
  ctx: any,
  ownerId: string,
  category: string,
  subcategory: string,
): Promise<void> => {
  const memories: Doc<"memories">[] = await ctx.runQuery(internal.data.memory.getExistingMemories, {
    ownerId,
    category,
    subcategory,
  });

  if (memories.length <= 1) {
    return;
  }

  const sorted = [...memories].sort((a, b) => {
    const aTs = a.updatedAt ?? a.createdAt;
    const bTs = b.updatedAt ?? b.createdAt;
    return bTs - aTs;
  });

  const keeper = sorted[0];
  if (!keeper) {
    return;
  }

  const source = sorted
    .map((memory, index) => {
      const ts = memory.updatedAt ?? memory.createdAt;
      return `[${index}] ts=${ts} ${memory.content}`;
    })
    .join("\n\n");

  const consolidated = (await cheapLLM(
    CONSOLIDATE_PROMPT,
    `Category: ${category}/${subcategory}\n\nRows:\n${source}`,
  )).trim();

  await ctx.runMutation(internal.data.memory.mergeMemory, {
    memoryId: keeper._id,
    content: consolidated.length > 0 ? consolidated : keeper.content,
  });

  for (const memory of sorted.slice(1)) {
    await ctx.runMutation(internal.data.memory.deleteMemory, {
      memoryId: memory._id,
    });
  }
};

const dedupFact = async (
  ctx: any,
  args: {
    ownerId: string;
    conversationId?: Id<"conversations">;
    category: string;
    subcategory: string;
    content: string;
  },
): Promise<Id<"memories"> | null> => {
  const existing: Doc<"memories">[] = await ctx.runQuery(internal.data.memory.getExistingMemories, {
    ownerId: args.ownerId,
    category: args.category,
    subcategory: args.subcategory,
  });

  if (existing.length === 0) {
    return await ctx.runMutation(internal.data.memory.insertMemory, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      category: args.category,
      subcategory: args.subcategory,
      content: args.content,
    });
  }

  const existingList = existing.map((memory, index) => `[${index}] ${memory.content}`).join("\n");
  const decision = await cheapLLM(
    DEDUP_PROMPT,
    `New fact:\n${args.content}\n\nExisting:\n${existingList}`,
  );

  try {
    const parsed = JSON.parse(decision.trim()) as {
      action?: string;
      content?: string;
      mergeTargetIndex?: number;
    };
    const action = (parsed.action ?? "INSERT").toUpperCase();

    if (action === "SKIP") {
      return null;
    }

    if (action === "MERGE") {
      const targetIndex = typeof parsed.mergeTargetIndex === "number" ? parsed.mergeTargetIndex : 0;
      const target = existing[targetIndex];
      const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
      if (target && content) {
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: target._id,
          content,
        });
        return target._id;
      }
    }
  } catch {
    // Fall through to insert.
  }

  return await ctx.runMutation(internal.data.memory.insertMemory, {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
    category: args.category,
    subcategory: args.subcategory,
    content: args.content,
  });
};

const applyDiffAgainstPreviousBatch = async (
  ctx: any,
  args: {
    batch: Doc<"memory_extraction_batches">;
    summary: string;
  },
): Promise<Array<Id<"memories">>> => {
  if (args.batch.snapshot.length === 0) {
    return [];
  }

  const previousList = args.batch.snapshot
    .map((row, index) =>
      `[${index}]${row.memoryId ? ` (id:${row.memoryId})` : ""} [${row.category}/${row.subcategory}] ${row.content}`,
    )
    .join("\n");

  const decisionRaw = await cheapLLM(
    DIFF_PROMPT,
    `Previous extraction batch:\n${previousList}\n\nNew conversation:\n${args.summary}`,
  );
  const decision = parseDiffDecision(decisionRaw);

  const touched = new Set<Id<"memories">>();

  for (const update of decision.updates) {
    const target = args.batch.snapshot[update.index];
    if (!target?.memoryId) continue;
    await ctx.runMutation(internal.data.memory.mergeMemory, {
      memoryId: target.memoryId,
      content: update.content,
    });
    touched.add(target.memoryId);
  }

  for (const del of decision.deletes) {
    const target = args.batch.snapshot[del.index];
    if (!target?.memoryId) continue;
    const existing = await ctx.runQuery(internal.data.memory.getMemoryById, {
      id: target.memoryId,
    });
    if (!existing) continue;
    await ctx.runMutation(internal.data.memory.deleteMemory, {
      memoryId: target.memoryId,
    });
  }

  return Array.from(touched);
};

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

    const previousBatch = await ctx.runQuery(internal.data.memory_architecture.getLatestExtractionBatch, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
    });

    if (previousBatch) {
      const touchedFromDiff = await applyDiffAgainstPreviousBatch(ctx, {
        batch: previousBatch,
        summary,
      });
      for (const id of touchedFromDiff) {
        touchedIds.add(id);
      }
    }

    if (extracted.parseOk) {
      for (const fact of extracted.facts) {
        const memoryId = await dedupFact(ctx, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          category: fact.category,
          subcategory: fact.subcategory,
          content: fact.content,
        });
        if (memoryId) {
          touchedIds.add(memoryId);
        }
      }
    }

    const snapshot: Array<{ category: string; subcategory: string; content: string; memoryId?: Id<"memories"> }> = [];
    for (const memoryId of touchedIds) {
      const memory = await ctx.runQuery(internal.data.memory.getMemoryById, {
        id: memoryId,
      });
      if (!memory) continue;
      snapshot.push({
        category: memory.category,
        subcategory: memory.subcategory,
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
      events: events.map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
        text:
          (event.payload && typeof event.payload === "object" &&
            typeof (event.payload as { text?: unknown }).text === "string")
            ? (event.payload as { text: string }).text
            : "",
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

export const enforceGrowthLimitsForOwner = internalAction({
  args: {
    ownerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const categories = await ctx.runQuery(internal.data.memory.listCategories, {
      ownerId: args.ownerId,
    });

    for (const category of categories) {
      if (category.count > MAX_MEMORIES_PER_SUBCATEGORY) {
        await consolidateSubcategory(ctx, args.ownerId, category.category, category.subcategory);
      }
    }

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
      .withIndex("by_owner_category")
      .take(limit);
    return Array.from(new Set(memories.map((m) => m.ownerId)));
  },
});

export const weeklyConsolidation = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const ownerIds = await ctx.runQuery(internal.data.memory_architecture.listDistinctMemoryOwners, {
      limit: 500,
    });

    for (const ownerId of ownerIds) {
      const categories = await ctx.runQuery(internal.data.memory.listCategories, {
        ownerId,
      });

      for (const category of categories) {
        if (category.count > WEEKLY_CONSOLIDATION_THRESHOLD) {
          await consolidateSubcategory(ctx, ownerId, category.category, category.subcategory);
        }
      }

      await ctx.runAction(internal.data.memory_architecture.enforceGrowthLimitsForOwner, {
        ownerId,
      });
    }

    return null;
  },
});

