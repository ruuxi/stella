import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { embed as aiEmbed, generateText } from "ai";
import { getModelConfig } from "./model";

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
  const config = getModelConfig("memory");
  const { text } = await generateText({
    ...config,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.1,
    maxOutputTokens: 4096,
  });
  return text;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FACT_EXTRACTION_PROMPT = `You extract discrete facts from conversation summaries. For each fact, assign a category and subcategory.

Categories:
- projects: subcategories are project names (e.g., "stellar", "my-app")
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
  handler: async (_ctx, args): Promise<Array<{ category: string; subcategory: string; content: string }>> => {
    const response = await cheapLLM(FACT_EXTRACTION_PROMPT, args.summary);
    try {
      const parsed = JSON.parse(response.trim());
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (f: unknown) =>
          f &&
          typeof f === "object" &&
          typeof (f as Record<string, unknown>).category === "string" &&
          typeof (f as Record<string, unknown>).subcategory === "string" &&
          typeof (f as Record<string, unknown>).content === "string",
      ) as Array<{ category: string; subcategory: string; content: string }>;
    } catch {
      return [];
    }
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
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      embedding: args.embedding,
      accessedAt: Date.now(),
      decay: 0,
    });
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
      return;
    }

    // 1. Extract facts
    const facts = await ctx.runAction(internal.memory.extractFacts, { summary });
    if (facts.length === 0) {
      await markIngested();
      return;
    }

    // 2. For each fact: dedup → embed → insert/merge
    for (const fact of facts) {
      const existing = await ctx.runQuery(internal.memory.getExistingMemories, {
        ownerId: args.ownerId,
        category: fact.category,
        subcategory: fact.subcategory,
      });

      let shouldInsert = true;
      let mergeTarget: { _id: string; content: string } | null = null;
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
          } else if (parsed.action === "MERGE" && typeof parsed.content === "string") {
            shouldInsert = false;
            const targetIdx = typeof parsed.mergeTargetIndex === "number" ? parsed.mergeTargetIndex : 0;
            const target = existing[targetIdx];
            if (target) {
              mergeTarget = { _id: target._id as string, content: target.content };
              mergedContent = parsed.content;
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
        await ctx.runMutation(internal.memory.mergeMemory, {
          memoryId: mergeTarget._id as any,
          content: mergedContent,
          embedding: vector,
        });
      } else if (shouldInsert) {
        const vector = await embed(fact.content);
        await ctx.runMutation(internal.memory.insertMemory, {
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
  handler: async (ctx, args): Promise<Array<{ category: string; subcategory: string; content: string; score: number }>> => {
    const vector = await embed(args.query);

    // Vector search filters only support q.eq and q.or — no AND.
    // Always filter by ownerId (security). Post-filter by category after fetch.
    const results = await ctx.vectorSearch("memories", "by_embedding", {
      vector,
      limit: args.category ? 32 : 10,
      filter: (q) => q.eq("ownerId", args.ownerId),
    });

    // Fetch full docs
    type MemoryDoc = {
      _id: string;
      category: string;
      subcategory: string;
      content: string;
    };
    const docs: Array<{ doc: MemoryDoc; score: number } | null> = await Promise.all(
      results.map(async (r) => {
        const doc = (await ctx.runQuery(internal.memory.getMemoryById, {
          id: r._id,
        })) as MemoryDoc | null;
        return doc ? { doc, score: r._score } : null;
      }),
    );

    // Post-filter by category, then limit to 10
    const matched = docs
      .filter((entry): entry is { doc: MemoryDoc; score: number } => {
        if (!entry) return false;
        if (args.category && entry.doc.category !== args.category) return false;
        return true;
      })
      .slice(0, 10);

    // Touch only the returned memories (reset decay + accessedAt)
    for (const entry of matched) {
      await ctx.runMutation(internal.memory.touchMemory, {
        memoryId: entry.doc._id as any,
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
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      accessedAt: Date.now(),
      decay: 0,
    });
  },
});

// ---------------------------------------------------------------------------
// getMemoryById (internal query)
// ---------------------------------------------------------------------------

export const getMemoryById = internalQuery({
  args: { id: v.id("memories") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------------
// listCategories (query) — grouped category/subcategory listing
// ---------------------------------------------------------------------------

export const listCategories = internalQuery({
  args: { ownerId: v.string() },
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

// ---------------------------------------------------------------------------
// decayMemories (internal action) — daily cron: re-summarize or delete stale memories
// ---------------------------------------------------------------------------

export const decayMemories = internalAction({
  args: {},
  handler: async (ctx) => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stale = await ctx.runQuery(internal.memory.listStaleMemories, {
      beforeTimestamp: sevenDaysAgo,
      limit: 50,
    });

    for (const memory of stale) {
      if (memory.decay >= 2) {
        await ctx.runMutation(internal.memory.deleteMemory, { memoryId: memory._id });
      } else {
        // Re-summarize
        const compressed = await cheapLLM(DECAY_SUMMARIZE_PROMPT, memory.content);
        const vector = await embed(compressed);
        await ctx.runMutation(internal.memory.patchDecay, {
          memoryId: memory._id,
          content: compressed,
          embedding: vector,
          decay: memory.decay + 1,
        });
      }
    }
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
  handler: async (ctx, args) => {
    // Query memories ordered by decay + accessedAt
    const results = await ctx.db
      .query("memories")
      .withIndex("by_decay")
      .take(args.limit * 3);

    return results
      .filter((m) => m.accessedAt < args.beforeTimestamp)
      .slice(0, args.limit);
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
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      embedding: args.embedding,
      decay: args.decay,
    });
  },
});

// ---------------------------------------------------------------------------
// deleteMemory (internal mutation)
// ---------------------------------------------------------------------------

export const deleteMemory = internalMutation({
  args: { memoryId: v.id("memories") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.memoryId);
  },
});
