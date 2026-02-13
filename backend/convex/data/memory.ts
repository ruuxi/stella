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
import { DISCOVERY_FACT_EXTRACTION_PROMPT } from "../prompts/discovery_facts";
import { RECALL_FILTER_PROMPT, SAVE_MEMORY_PROMPT } from "../prompts/memory";
import { requireUserId } from "../auth";

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

const memoryFactValidator = v.object({
  category: v.string(),
  subcategory: v.string(),
  content: v.string(),
});

const factExtractionResultValidator = v.object({
  facts: v.array(memoryFactValidator),
  parseOk: v.boolean(),
});
// ---------------------------------------------------------------------------
// Cheap LLM helper (for fact extraction, dedup, decay, recall, save)
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

/**
 * Build a category-aware version of FACT_EXTRACTION_PROMPT.
 * Injects the existing category tree so the LLM prefers existing
 * categories but can still create new ones when needed.
 */
function buildCategoryAwareExtractionPrompt(
  existingCategories: { category: string; subcategory: string }[],
): string {
  const tree = new Map<string, Set<string>>();
  for (const { category, subcategory } of existingCategories) {
    if (!tree.has(category)) tree.set(category, new Set());
    tree.get(category)!.add(subcategory);
  }

  if (tree.size === 0) return FACT_EXTRACTION_PROMPT;

  const treeLines = Array.from(tree.entries())
    .map(([cat, subs]) => `- ${cat}: ${Array.from(subs).join(", ")}`)
    .join("\n");

  return `You extract discrete facts from conversation summaries. For each fact, assign a category and subcategory.

Existing categories in the user's memory:
${treeLines}

Default categories (use when nothing existing fits):
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
- PREFER using existing categories/subcategories listed above when the information fits
- Create new categories or subcategories only when nothing existing is appropriate
- Deduplicate within your output
- Output ONLY the JSON array, nothing else`;
}

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
  args: { summary: v.string(), promptOverride: v.optional(v.string()) },
  returns: factExtractionResultValidator,
  handler: async (_ctx, args): Promise<FactExtractionResult> => {
    const response = await cheapLLM(args.promptOverride ?? FACT_EXTRACTION_PROMPT, args.summary);
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
      accessedAt: now,
      createdAt: now,
      updatedAt: now,
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      accessedAt: now,
      updatedAt: now,
      decay: 0,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// ingestSummary (internal action) — orchestrates extraction → dedup → insert
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

    // 1. Build category-aware prompt, then extract facts
    const existingCategories = await ctx.runQuery(internal.data.memory.listCategories, {
      ownerId: args.ownerId,
    });
    const extractionPrompt = buildCategoryAwareExtractionPrompt(existingCategories);
    const { facts, parseOk } = await ctx.runAction(internal.data.memory.extractFacts, {
      summary,
      promptOverride: extractionPrompt,
    });
    if (!parseOk) {
      return null;
    }
    if (facts.length === 0) {
      await markIngested();
      return null;
    }

    // 2. For each fact: dedup → insert/merge
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
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: mergeTarget._id,
          content: mergedContent,
        });
      } else if (shouldInsert) {
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          category: fact.category,
          subcategory: fact.subcategory,
          content: fact.content,
        });
      }
    }

    await markIngested();
    return null;
  },
});

// ---------------------------------------------------------------------------
// recallMemories (internal action) — category-indexed read + LLM filter
// ---------------------------------------------------------------------------

export const recallMemories = internalAction({
  args: {
    ownerId: v.string(),
    categories: v.array(v.object({
      category: v.string(),
      subcategory: v.string(),
    })),
    query: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // 1. Fetch all memory rows for each category/subcategory pair
    const allMemories: Doc<"memories">[] = [];
    for (const pair of args.categories) {
      const memories = await ctx.runQuery(internal.data.memory.getExistingMemories, {
        ownerId: args.ownerId,
        category: pair.category,
        subcategory: pair.subcategory,
      });
      allMemories.push(...memories);
    }

    if (allMemories.length === 0) {
      return "No memories found for the requested categories.";
    }

    // 2. Format for LLM with IDs
    const memoryList = allMemories.map((m, i) =>
      `[${i}] (id:${m._id}) [${m.category}/${m.subcategory}] ${m.content}`,
    ).join("\n");

    // 3. Call cheap LLM to filter and synthesize
    const response = await cheapLLM(
      RECALL_FILTER_PROMPT,
      `Memories:\n${memoryList}\n\nQuery: ${args.query}`,
    );

    // 4. Parse response, touch used memories
    try {
      const parsed = JSON.parse(response.trim());
      const usedIds: string[] = Array.isArray(parsed.usedIds) ? parsed.usedIds : [];
      const context = parsed.context;

      // Null context means "nothing relevant" — return empty signal
      if (context === null || context === undefined) {
        return "";
      }

      const contextStr: string = typeof context === "string" ? context : response;

      const validIds = usedIds
        .map((id) => allMemories.find((m) => String(m._id) === id)?._id)
        .filter((id): id is Id<"memories"> => id !== undefined);

      if (validIds.length > 0) {
        await ctx.runMutation(internal.data.memory.touchMemoriesById, {
          memoryIds: validIds,
        });
      }

      return contextStr;
    } catch {
      // LLM didn't return valid JSON — return raw text
      return response;
    }
  },
});

// ---------------------------------------------------------------------------
// saveMemory (internal action) — explicit write with dedup
// ---------------------------------------------------------------------------

export const saveMemory = internalAction({
  args: {
    ownerId: v.string(),
    category: v.string(),
    subcategory: v.string(),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    // 1. Fetch existing memories for this category/subcategory
    const existing = await ctx.runQuery(internal.data.memory.getExistingMemories, {
      ownerId: args.ownerId,
      category: args.category,
      subcategory: args.subcategory,
    });

    if (existing.length === 0) {
      // No existing — just insert
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        category: args.category,
        subcategory: args.subcategory,
        content: args.content,
      });
      return `Memory saved in ${args.category}/${args.subcategory}.`;
    }

    // 2. Ask LLM to decide INSERT/UPDATE/NOOP
    const existingList = existing.map((m, i) =>
      `[${i}] (id:${m._id}) ${m.content}`,
    ).join("\n");

    const response = await cheapLLM(
      SAVE_MEMORY_PROMPT,
      `New information:\n${args.content}\n\nExisting memories in ${args.category}/${args.subcategory}:\n${existingList}`,
    );

    // 3. Execute decision
    try {
      const parsed = JSON.parse(response.trim());
      const action = (typeof parsed.action === "string" ? parsed.action : "INSERT").toUpperCase();

      if (action === "NOOP" || action === "SKIP") {
        return `Already captured in ${args.category}/${args.subcategory}.`;
      }

      if (action === "UPDATE" && parsed.id && parsed.content) {
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: parsed.id as Id<"memories">,
          content: parsed.content,
        });
        return `Memory updated in ${args.category}/${args.subcategory}.`;
      }

      // INSERT
      const content = (typeof parsed.content === "string" && parsed.content.trim())
        ? parsed.content
        : args.content;
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        category: args.category,
        subcategory: args.subcategory,
        content,
      });
      return `Memory saved in ${args.category}/${args.subcategory}.`;
    } catch {
      // Fallback: insert as-is
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        category: args.category,
        subcategory: args.subcategory,
        content: args.content,
      });
      return `Memory saved (fallback) in ${args.category}/${args.subcategory}.`;
    }
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

export const listCategoriesForOwner = internalQuery({
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
      limit: 200,
    });

    for (const memory of stale) {
      if (memory.decay >= 2) {
        await ctx.runMutation(internal.data.memory.deleteMemory, { memoryId: memory._id });
      } else {
        // Re-summarize
        const compressed = await cheapLLM(DECAY_SUMMARIZE_PROMPT, memory.content);
        await ctx.runMutation(internal.data.memory.patchDecay, {
          memoryId: memory._id,
          content: compressed,
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
    decay: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      updatedAt: Date.now(),
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
              await ctx.runMutation(internal.data.memory.mergeMemory, {
                memoryId: existing[parsed.mergeTargetIndex]._id,
                content: parsed.content,
              });
              continue;
            }
          } catch {
            // Fall through to insert on parse failure
          }
        }

        // Insert new memory
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          category: fact.category,
          subcategory: fact.subcategory,
          content: fact.content,
        });
      } catch (err) {
        console.error(`[memory] seedFromDiscovery: error processing fact`, fact.category, fact.subcategory, err);
      }
    }

    await ctx.runAction(internal.data.memory_architecture.enforceGrowthLimitsForOwner, {
      ownerId: args.ownerId,
    });
    console.log("[memory] seedFromDiscovery: complete");
    return null;
  },
});

