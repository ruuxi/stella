import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { generateText, embed } from "ai";
import { getModelConfig } from "../agent/model";
import { DISCOVERY_FACT_EXTRACTION_PROMPT } from "../prompts/discovery_facts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEDUP_THRESHOLD = 0.9;
const RECALL_MIN_SCORE = 0.7;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

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

const memoryFactValidator = v.object({
  content: v.string(),
});

const factExtractionResultValidator = v.object({
  facts: v.array(memoryFactValidator),
  parseOk: v.boolean(),
});

// ---------------------------------------------------------------------------
// Cheap LLM helper (for fact extraction)
// ---------------------------------------------------------------------------

async function cheapLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const config = getModelConfig("memory_ops");
  const { text } = await generateText({
    ...config,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return text;
}

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
// Types
// ---------------------------------------------------------------------------

type MemoryFact = { content: string };
type FactExtractionResult = { facts: MemoryFact[]; parseOk: boolean };

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const extractJsonArray = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1).trim();
};

const normalizeFacts = (parsed: unknown): MemoryFact[] => {
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const facts: MemoryFact[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string") continue;
    const content = record.content.trim();
    if (!content) continue;
    if (seen.has(content)) continue;
    seen.add(content);
    facts.push({ content });
  }
  return facts;
};

const parseFactResponse = (response: string): FactExtractionResult => {
  const trimmed = response.trim();
  const tryParse = (value: string): FactExtractionResult | null => {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return { facts: normalizeFacts(parsed), parseOk: true };
      }
      if (parsed && typeof parsed === "object") {
        const facts = (parsed as Record<string, unknown>).facts;
        if (Array.isArray(facts)) {
          return { facts: normalizeFacts(facts), parseOk: true };
        }
      }
      return { facts: [], parseOk: false };
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const arrayBlock = extractJsonArray(trimmed);
  if (arrayBlock) {
    const fromBlock = tryParse(arrayBlock);
    if (fromBlock) return fromBlock;
  }

  return { facts: [], parseOk: false };
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FACT_EXTRACTION_PROMPT = `You extract discrete facts from conversation summaries.

Output valid JSON array:
[{"content":"..."}]

Rules:
- Each fact should be a single, self-contained piece of information
- Be specific and preserve important details (names, versions, paths)
- Deduplicate within your output
- Output ONLY the JSON array, nothing else`;

// ---------------------------------------------------------------------------
// extractFacts (internal action)
// ---------------------------------------------------------------------------

export const extractFacts = internalAction({
  args: { summary: v.string(), promptOverride: v.optional(v.string()) },
  returns: factExtractionResultValidator,
  handler: async (_ctx, args): Promise<FactExtractionResult> => {
    const response = await cheapLLM(args.promptOverride ?? FACT_EXTRACTION_PROMPT, args.summary);
    return parseFactResponse(response);
  },
});

// ---------------------------------------------------------------------------
// insertMemory (internal mutation)
// ---------------------------------------------------------------------------

export const insertMemory = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("memories", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      content: args.content,
      embedding: args.embedding,
      accessedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ---------------------------------------------------------------------------
// mergeMemory (internal mutation) — update content and optionally re-embed
// ---------------------------------------------------------------------------

export const mergeMemory = internalMutation({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const patch: Record<string, unknown> = {
      content: args.content,
      accessedAt: now,
      updatedAt: now,
    };
    if (args.embedding) {
      patch.embedding = args.embedding;
    }
    await ctx.db.patch(args.memoryId, patch);
    return null;
  },
});

// ---------------------------------------------------------------------------
// touchMemoriesById (internal mutation) — update accessedAt for used memories
// ---------------------------------------------------------------------------

export const touchMemoriesById = internalMutation({
  args: { memoryIds: v.array(v.id("memories")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await Promise.all(
      args.memoryIds.map((id) => ctx.db.patch(id, { accessedAt: now })),
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// getMemoryById (internal query)
// ---------------------------------------------------------------------------

export const getMemoryById = internalQuery({
  args: { id: v.id("memories") },
  returns: v.union(memoryValidator, v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------------
// getMemoriesByIds (internal query)
// ---------------------------------------------------------------------------

export const getMemoriesByIds = internalQuery({
  args: { ids: v.array(v.id("memories")) },
  returns: v.array(memoryValidator),
  handler: async (ctx, args) => {
    const results = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return results.filter((m): m is NonNullable<typeof m> => m !== null);
  },
});

// ---------------------------------------------------------------------------
// deleteMemory (internal mutation)
// ---------------------------------------------------------------------------

export const deleteMemory = internalMutation({
  args: { memoryId: v.id("memories") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.memoryId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// ingestSummary (internal action) — extract facts → embed → dedup → insert
// ---------------------------------------------------------------------------

export const ingestSummary = internalAction({
  args: {
    conversationId: v.optional(v.id("conversations")),
    ownerId: v.string(),
    events: v.array(v.object({ type: v.string(), text: v.string() })),
    ingestedThroughTimestamp: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const markIngested = async () => {
      if (args.conversationId && typeof args.ingestedThroughTimestamp === "number") {
        await ctx.runMutation(internal.conversations.patchLastIngestedAt, {
          conversationId: args.conversationId,
          lastIngestedAt: args.ingestedThroughTimestamp,
        });
      }
    };

    const summary = args.events
      .filter((e) => e.text.trim().length > 0)
      .map((e) => `[${e.type}] ${e.text}`)
      .join("\n\n");

    if (summary.trim().length === 0) {
      await markIngested();
      return null;
    }

    const { facts, parseOk } = await ctx.runAction(internal.data.memory.extractFacts, {
      summary,
    });
    if (!parseOk || facts.length === 0) {
      await markIngested();
      return null;
    }

    for (const fact of facts) {
      try {
        const vector = await embedText(fact.content);
        const similar = await ctx.vectorSearch("memories", "by_embedding", {
          vector,
          limit: 3,
          filter: (q) => q.eq("ownerId", args.ownerId),
        });

        const isDuplicate = similar.length > 0 && similar[0]._score > DEDUP_THRESHOLD;
        if (isDuplicate) {
          await ctx.runMutation(internal.data.memory.touchMemoriesById, {
            memoryIds: [similar[0]._id],
          });
          continue;
        }

        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          content: fact.content,
          embedding: vector,
        });
      } catch (err) {
        console.error("[memory] ingestSummary: error processing fact", err);
      }
    }

    await markIngested();
    return null;
  },
});

// ---------------------------------------------------------------------------
// recallMemories (internal action) — vector search recall
// ---------------------------------------------------------------------------

export const recallMemories = internalAction({
  args: {
    ownerId: v.string(),
    query: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    if (!args.query.trim()) return "";

    try {
      const vector = await embedText(args.query);
      const results = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: 10,
        filter: (q) => q.eq("ownerId", args.ownerId),
      });

      const relevant = results.filter((r) => r._score > RECALL_MIN_SCORE);
      if (relevant.length === 0) return "";

      const ids = relevant.map((r) => r._id);
      const docs: Array<{ _id: Id<"memories">; content: string }> =
        await ctx.runQuery(internal.data.memory.getMemoriesByIds, { ids });

      if (docs.length > 0) {
        await ctx.runMutation(internal.data.memory.touchMemoriesById, {
          memoryIds: docs.map((d: { _id: Id<"memories"> }) => d._id),
        });
      }

      return docs.map((d: { content: string }) => `- ${d.content}`).join("\n");
    } catch (err) {
      console.error("[memory] recallMemories failed:", err);
      return "";
    }
  },
});

// ---------------------------------------------------------------------------
// saveMemory (internal action) — explicit write with embedding dedup
// ---------------------------------------------------------------------------

export const saveMemory = internalAction({
  args: {
    ownerId: v.string(),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      const vector = await embedText(args.content);
      const similar = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: 3,
        filter: (q) => q.eq("ownerId", args.ownerId),
      });

      if (similar.length > 0 && similar[0]._score > DEDUP_THRESHOLD) {
        await ctx.runMutation(internal.data.memory.touchMemoriesById, {
          memoryIds: [similar[0]._id],
        });
        return "Already captured.";
      }

      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        content: args.content,
        embedding: vector,
      });
      return "Memory saved.";
    } catch (err) {
      console.error("[memory] saveMemory failed:", err);
      return `SaveMemory failed: ${(err as Error).message}`;
    }
  },
});

// ---------------------------------------------------------------------------
// decayMemories (internal action) — daily cron: delete stale memories
// ---------------------------------------------------------------------------

export const decayMemories = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stale = await ctx.runQuery(internal.data.memory.listStaleMemories, {
      beforeTimestamp: thirtyDaysAgo,
      limit: 200,
    });

    for (const memory of stale) {
      await ctx.runMutation(internal.data.memory.deleteMemory, { memoryId: memory._id });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// listStaleMemories (internal query)
// ---------------------------------------------------------------------------

export const listStaleMemories = internalQuery({
  args: {
    beforeTimestamp: v.number(),
    limit: v.number(),
  },
  returns: v.array(memoryValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memories")
      .withIndex("by_accessed", (q) =>
        q.lt("accessedAt", args.beforeTimestamp),
      )
      .order("asc")
      .take(args.limit);
  },
});

// ---------------------------------------------------------------------------
// Seed from Discovery (populate memory from discovery signals)
// ---------------------------------------------------------------------------

export const seedFromDiscovery = internalAction({
  args: {
    ownerId: v.string(),
    formattedSignals: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const response = await cheapLLM(DISCOVERY_FACT_EXTRACTION_PROMPT, args.formattedSignals);
    const { facts, parseOk } = parseFactResponse(response);

    if (!parseOk || facts.length === 0) {
      console.log("[memory] seedFromDiscovery: no facts extracted", { parseOk, factCount: facts.length });
      return null;
    }

    console.log(`[memory] seedFromDiscovery: extracted ${facts.length} facts, inserting...`);

    for (const fact of facts) {
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
          continue;
        }

        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          content: fact.content,
          embedding: vector,
        });
      } catch (err) {
        console.error("[memory] seedFromDiscovery: error processing fact", err);
      }
    }

    await ctx.runAction(internal.data.memory_architecture.enforceGrowthLimitsForOwner, {
      ownerId: args.ownerId,
    });
    console.log("[memory] seedFromDiscovery: complete");
    return null;
  },
});

// ---------------------------------------------------------------------------
// Backfill embeddings (one-time migration action)
// ---------------------------------------------------------------------------

export const backfillEmbeddings = internalAction({
  args: {
    batchSize: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    processed: v.number(),
    nextCursor: v.optional(v.string()),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<{ processed: number; nextCursor?: string; done: boolean }> => {
    const batchSize = args.batchSize ?? 50;
    const memories: Array<{ _id: Id<"memories">; content: string }> =
      await ctx.runQuery(internal.data.memory.listMemoriesWithoutEmbedding, {
        limit: batchSize,
      });

    if (memories.length === 0) {
      return { processed: 0, done: true };
    }

    let processed = 0;
    for (const memory of memories) {
      try {
        const vector = await embedText(memory.content);
        await ctx.runMutation(internal.data.memory.patchEmbedding, {
          memoryId: memory._id,
          embedding: vector,
        });
        processed++;
      } catch (err) {
        console.error(`[memory] backfill failed for ${memory._id}:`, err);
      }
    }

    const hasMore: boolean = memories.length === batchSize;
    return {
      processed,
      nextCursor: hasMore ? String(memories[memories.length - 1]._id) : undefined,
      done: !hasMore,
    };
  },
});

export const listMemoriesWithoutEmbedding = internalQuery({
  args: { limit: v.number() },
  returns: v.array(v.object({
    _id: v.id("memories"),
    content: v.string(),
  })),
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("memories")
      .withIndex("by_accessed")
      .take(args.limit * 10);
    return all
      .filter((m) => !m.embedding || m.embedding.length === 0)
      .slice(0, args.limit)
      .map((m) => ({ _id: m._id, content: m.content }));
  },
});

export const patchEmbedding = internalMutation({
  args: {
    memoryId: v.id("memories"),
    embedding: v.array(v.float64()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, { embedding: args.embedding });
    return null;
  },
});
