import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { embed as aiEmbed, generateText } from "ai";
import { getModelConfig } from "../agent/model";
import { DISCOVERY_FACT_EXTRACTION_PROMPT } from "../prompts/discovery_facts";
import { requireUserId } from "../auth";

const memoryValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  category: v.string(),
  subcategory: v.string(),
  content: v.string(),
  embedding: v.array(v.float64()),
  accessedAt: v.number(),
  createdAt: v.number(),
  decay: v.number(),
});

const memoryFactValidator = v.object({
  category: v.string(),
  subcategory: v.string(),
  content: v.string(),
});

const factExtractionResultValidator = v.object({
  facts: v.array(memoryFactValidator),
  parseOk: v.boolean(),
});

const memorySearchResultValidator = v.object({
  category: v.string(),
  subcategory: v.string(),
  content: v.string(),
  score: v.number(),
});

// ---------------------------------------------------------------------------
// Embedding helper — uses the AI SDK gateway, same as streamText
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[]> {
  const config = getModelConfig("embedding");
  const { embedding } = await aiEmbed({
    ...config,
    value: text,
  });
  return embedding;
}

// ---------------------------------------------------------------------------
// Cheap LLM helper (for fact extraction, dedup, decay summarization)
// Uses the AI SDK generateText, same provider routing as streamText.
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

type MemoryFact = { category: string; subcategory: string; content: string };
type FactExtractionResult = { facts: MemoryFact[]; parseOk: boolean };

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
    if (
      typeof record.category !== "string" ||
      typeof record.subcategory !== "string" ||
      typeof record.content !== "string"
    ) {
      continue;
    }
    const category = record.category.trim();
    const subcategory = record.subcategory.trim();
    const content = record.content.trim();
    if (!category || !subcategory || !content) continue;
    const key = `${category}|${subcategory}|${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ category, subcategory, content });
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

const FACT_EXTRACTION_PROMPT = `You extract discrete facts from conversation summaries. For each fact, assign a category and subcategory.

Categories:
- projects: subcategories are project names (e.g., "Stella", "my-app")
- personal: preferences, habits, biographical info
- tasks: things the user wants to do, action items, goals
- technical: technical knowledge, solutions, configurations
- preferences: tool preferences, communication style, workflow preferences
- people: people the user knows, relationships, contacts

Output valid JSON array:
[{"category":"...","subcategory":"...","content":"..."}]

Rules:
- Each fact should be a single, self-contained piece of information
- Be specific and preserve important details (names, versions, paths)
- Deduplicate within your output
- Output ONLY the JSON array, nothing else`;

const DEDUP_PROMPT = `Compare a new fact against existing memories in the same subcategory. Decide:
- INSERT: new information not captured by existing memories
- SKIP: already captured by an existing memory
- MERGE: overlaps with an existing memory; provide merged content

Output valid JSON:
{"action":"INSERT"|"SKIP"|"MERGE","content":"...merged content if MERGE, else empty","mergeTargetIndex":0}

mergeTargetIndex is the 0-based index of the existing memory to merge with (only for MERGE).
Output ONLY the JSON, nothing else.`;

const DECAY_SUMMARIZE_PROMPT = `Compress this memory into a shorter, more abstract version while preserving the core information. Output ONLY the compressed text, nothing else.`;

// ---------------------------------------------------------------------------
// extractFacts (internal action)
// ---------------------------------------------------------------------------

export const extractFacts = internalAction({
  args: { summary: v.string() },
  returns: factExtractionResultValidator,
  handler: async (_ctx, args): Promise<FactExtractionResult> => {
    const response = await cheapLLM(FACT_EXTRACTION_PROMPT, args.summary);
    return parseFactResponse(response);
  },
});

// ---------------------------------------------------------------------------
// getExistingMemories (internal query)
// ---------------------------------------------------------------------------

export const getExistingMemories = internalQuery({
  args: {
    ownerId: v.string(),
    category: v.string(),
    subcategory: v.string(),
  },
  returns: v.array(memoryValidator),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("memories")
      .withIndex("by_owner_category", (q) =>
        q.eq("ownerId", args.ownerId).eq("category", args.category).eq("subcategory", args.subcategory),
      )
      .take(50);
  },
});

// ---------------------------------------------------------------------------
// insertMemory (internal mutation)
// ---------------------------------------------------------------------------

export const insertMemory = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    category: v.string(),
    subcategory: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("memories", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      category: args.category,
      subcategory: args.subcategory,
      content: args.content,
      embedding: args.embedding,
      accessedAt: now,
      createdAt: now,
      decay: 0,
    });
  },
});

// ---------------------------------------------------------------------------
// mergeMemory (internal mutation)
// ---------------------------------------------------------------------------

export const mergeMemory = internalMutation({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    embedding: v.array(v.float64()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      embedding: args.embedding,
      accessedAt: Date.now(),
      decay: 0,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// ingestSummary (internal action) — orchestrates extraction → dedup → embed → insert
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

    // Build a summary string from events
    const summary = args.events
      .filter((e) => e.text.trim().length > 0)
      .map((e) => `[${e.type}] ${e.text}`)
      .join("\n\n");

    if (summary.trim().length === 0) {
      await markIngested();
      return null;
    }

    // 1. Extract facts
    const { facts, parseOk } = await ctx.runAction(internal.data.memory.extractFacts, { summary });
    if (!parseOk) {
      return null;
    }
    if (facts.length === 0) {
      await markIngested();
      return null;
    }

    // 2. For each fact: dedup → embed → insert/merge
    for (const fact of facts) {
      const existing = await ctx.runQuery(internal.data.memory.getExistingMemories, {
        ownerId: args.ownerId,
        category: fact.category,
        subcategory: fact.subcategory,
      });

      let shouldInsert = true;
      let mergeTarget: { _id: Id<"memories">; content: string } | null = null;
      let mergedContent = "";

      if (existing.length > 0) {
        const existingList = existing
          .map((m: { content: string }, i: number) => `[${i}] ${m.content}`)
          .join("\n");
        const dedupInput = `New fact:\n${fact.content}\n\nExisting memories:\n${existingList}`;
        const dedupResult = await cheapLLM(DEDUP_PROMPT, dedupInput);

        try {
          const parsed = JSON.parse(dedupResult.trim());
          if (parsed.action === "SKIP") {
            shouldInsert = false;
          } else if (parsed.action === "MERGE") {
            const parsedContent = typeof parsed.content === "string" ? parsed.content.trim() : "";
            const targetIdx = typeof parsed.mergeTargetIndex === "number" ? parsed.mergeTargetIndex : 0;
            const target = existing[targetIdx];
            if (target && parsedContent.length > 0) {
              shouldInsert = false;
              mergeTarget = { _id: target._id, content: target.content };
              mergedContent = parsedContent;
            } else {
              shouldInsert = true;
            }
          }
        } catch {
          // Parse failed, just insert
        }
      }

      if (mergeTarget && mergedContent) {
        const vector = await embed(mergedContent);
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: mergeTarget._id,
          content: mergedContent,
          embedding: vector,
        });
      } else if (shouldInsert) {
        const vector = await embed(fact.content);
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          category: fact.category,
          subcategory: fact.subcategory,
          content: fact.content,
          embedding: vector,
        });
      }
    }

    await markIngested();
    return null;
  },
});

// ---------------------------------------------------------------------------
// search (action) — embed query → vectorSearch → return results
// ---------------------------------------------------------------------------

export const search = internalAction({
  args: {
    query: v.string(),
    category: v.optional(v.string()),
    ownerId: v.string(),
  },
  returns: v.array(memorySearchResultValidator),
  handler: async (ctx, args): Promise<Array<{ category: string; subcategory: string; content: string; score: number }>> => {
    const vector = await embed(args.query);

    const searchLimit = args.category ? 256 : 10;

    // Vector search filters only support q.eq and q.or — no AND.
    // Always filter by ownerId (security). Post-filter by category after fetch.
    const ownerResults = await ctx.vectorSearch("memories", "by_embedding", {
      vector,
      limit: searchLimit,
      filter: (q) => q.eq("ownerId", args.ownerId),
    });

    let results = ownerResults;
    if (args.category) {
      const category = args.category;
      const categoryResults = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: 256,
        filter: (q) => q.eq("category", category),
      });
      const merged = new Map<string, { _id: any; _score: number }>();
      const addResult = (item: { _id: any; _score: number }) => {
        const key = String(item._id);
        const existing = merged.get(key);
        if (!existing || item._score > existing._score) {
          merged.set(key, { _id: item._id, _score: item._score });
        }
      };
      ownerResults.forEach(addResult);
      categoryResults.forEach(addResult);
      results = Array.from(merged.values()).sort(
        (a, b) => b._score - a._score || String(a._id).localeCompare(String(b._id)),
      );
    }

    // Fetch full docs
    type MemoryDoc = {
      _id: Id<"memories">;
      ownerId: string;
      category: string;
      subcategory: string;
      content: string;
    };
    const docs: Array<{ doc: MemoryDoc; score: number } | null> = await Promise.all(
      results.map(async (r) => {
        const doc = (await ctx.runQuery(internal.data.memory.getMemoryById, {
          id: r._id,
        })) as MemoryDoc | null;
        return doc ? { doc, score: r._score } : null;
      }),
    );

    // Post-filter by category, then limit to 10
    const matched = docs
      .filter((entry): entry is { doc: MemoryDoc; score: number } => {
        if (!entry) return false;
        if (entry.doc.ownerId !== args.ownerId) return false;
        if (args.category && entry.doc.category !== args.category) return false;
        return true;
      })
      .slice(0, 10);

    // Touch all returned memories in a single mutation (reset decay + accessedAt)
    if (matched.length > 0) {
      await ctx.runMutation(internal.data.memory.touchMemories, {
        memoryIds: matched.map((entry) => entry.doc._id),
      });
    }

    return matched.map((entry) => ({
      category: entry.doc.category,
      subcategory: entry.doc.subcategory,
      content: entry.doc.content,
      score: entry.score,
    }));
  },
});

// ---------------------------------------------------------------------------
// touchMemory (internal mutation) — reset accessedAt + decay on access
// ---------------------------------------------------------------------------

export const touchMemory = internalMutation({
  args: { memoryId: v.id("memories") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      accessedAt: Date.now(),
      decay: 0,
    });
    return null;
  },
});

export const touchMemories = internalMutation({
  args: { memoryIds: v.array(v.id("memories")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await Promise.all(
      args.memoryIds.map((id) =>
        ctx.db.patch(id, { accessedAt: now, decay: 0 }),
      ),
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
// listCategories (query) — grouped category/subcategory listing
// ---------------------------------------------------------------------------

export const listCategories = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.object({
    category: v.string(),
    subcategory: v.string(),
    count: v.number(),
  })),
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("memories")
      .withIndex("by_owner_category", (q) => q.eq("ownerId", args.ownerId))
      .take(500);

    const counts = new Map<string, number>();
    for (const m of all) {
      const key = `${m.category}/${m.subcategory}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([key, count]) => {
      const [category, subcategory] = key.split("/");
      return { category, subcategory, count };
    });
  },
});

export const listCategoriesForOwner = query({
  args: {},
  returns: v.array(v.object({
    category: v.string(),
    subcategory: v.string(),
    count: v.number(),
  })),
  handler: async (ctx) => {
    const ownerId = await requireUserId(ctx);
    const all = await ctx.db
      .query("memories")
      .withIndex("by_owner_category", (q) => q.eq("ownerId", ownerId))
      .take(500);

    const counts = new Map<string, number>();
    for (const memory of all) {
      const key = `${memory.category}/${memory.subcategory}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([key, count]) => {
      const [category, subcategory] = key.split("/");
      return { category, subcategory, count };
    });
  },
});

// ---------------------------------------------------------------------------
// decayMemories (internal action) — daily cron: re-summarize or delete stale memories
// ---------------------------------------------------------------------------

export const decayMemories = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stale = await ctx.runQuery(internal.data.memory.listStaleMemories, {
      beforeTimestamp: sevenDaysAgo,
      limit: 50,
    });

    for (const memory of stale) {
      if (memory.decay >= 2) {
        await ctx.runMutation(internal.data.memory.deleteMemory, { memoryId: memory._id });
      } else {
        // Re-summarize
        const compressed = await cheapLLM(DECAY_SUMMARIZE_PROMPT, memory.content);
        const vector = await embed(compressed);
        await ctx.runMutation(internal.data.memory.patchDecay, {
          memoryId: memory._id,
          content: compressed,
          embedding: vector,
          decay: memory.decay + 1,
        });
      }
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
    const decayLevels = [0, 1, 2, 3];
    const candidates: Doc<"memories">[] = [];

    for (const decay of decayLevels) {
      const items = await ctx.db
        .query("memories")
        .withIndex("by_decay", (q) =>
          q.eq("decay", decay).lt("accessedAt", args.beforeTimestamp),
        )
        .take(args.limit);
      candidates.push(...items);
    }

    candidates.sort(
      (a, b) =>
        a.accessedAt - b.accessedAt ||
        a.decay - b.decay ||
        String(a._id).localeCompare(String(b._id)),
    );

    return candidates.slice(0, args.limit);
  },
});

// ---------------------------------------------------------------------------
// patchDecay (internal mutation)
// ---------------------------------------------------------------------------

export const patchDecay = internalMutation({
  args: {
    memoryId: v.id("memories"),
    content: v.string(),
    embedding: v.array(v.float64()),
    decay: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      embedding: args.embedding,
      decay: args.decay,
    });
    return null;
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
// Seed from Discovery (populate ephemeral memory from discovery signals)
// ---------------------------------------------------------------------------

export const seedFromDiscovery = internalAction({
  args: {
    ownerId: v.string(),
    formattedSignals: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Extract facts using discovery-specific prompt
    const response = await cheapLLM(DISCOVERY_FACT_EXTRACTION_PROMPT, args.formattedSignals);
    const { facts, parseOk } = parseFactResponse(response);

    if (!parseOk || facts.length === 0) {
      console.log("[memory] seedFromDiscovery: no facts extracted", { parseOk, factCount: facts.length });
      return null;
    }

    console.log(`[memory] seedFromDiscovery: extracted ${facts.length} facts, inserting...`);

    for (const fact of facts) {
      try {
        // Check for existing memories in the same category/subcategory
        const existing = await ctx.runQuery(internal.data.memory.getExistingMemories, {
          ownerId: args.ownerId,
          category: fact.category,
          subcategory: fact.subcategory,
        });

        if (existing.length > 0) {
          // Dedup against existing memories
          const existingList = existing.map((m: Doc<"memories">, i: number) => `[${i}] ${m.content}`).join("\n");
          const dedupInput = `New fact:\n${fact.content}\n\nExisting memories:\n${existingList}`;
          const dedupResult = await cheapLLM(DEDUP_PROMPT, dedupInput);

          try {
            const parsed = JSON.parse(dedupResult.trim());
            if (parsed.action === "SKIP") continue;
            if (parsed.action === "MERGE" && parsed.content && existing[parsed.mergeTargetIndex]) {
              const vec = await embed(parsed.content);
              await ctx.runMutation(internal.data.memory.mergeMemory, {
                memoryId: existing[parsed.mergeTargetIndex]._id,
                content: parsed.content,
                embedding: vec,
              });
              continue;
            }
          } catch {
            // Fall through to insert on parse failure
          }
        }

        // Insert new memory
        const vec = await embed(fact.content);
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          category: fact.category,
          subcategory: fact.subcategory,
          content: fact.content,
          embedding: vec,
        });
      } catch (err) {
        console.error(`[memory] seedFromDiscovery: error processing fact`, fact.category, fact.subcategory, err);
      }
    }

    console.log("[memory] seedFromDiscovery: complete");
    return null;
  },
});

// ---------------------------------------------------------------------------
// insertMemoryWithEmbedding (internal action) — embed + insert in one call
// ---------------------------------------------------------------------------

export const insertMemoryWithEmbedding = internalAction({
  args: {
    ownerId: v.string(),
    category: v.string(),
    subcategory: v.string(),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const vector = await embed(args.content);
    await ctx.runMutation(internal.data.memory.insertMemory, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      category: args.category,
      subcategory: args.subcategory,
      content: args.content,
      embedding: vector,
    });
    return null;
  },
});
