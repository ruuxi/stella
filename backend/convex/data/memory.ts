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
import { DISCOVERY_FACT_EXTRACTION_PROMPT } from "../prompts/discovery_facts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECALL_CANDIDATE_LIMIT = 30;
const RECALL_MAX_SELECTED = 8;
const HISTORY_CANDIDATE_LIMIT = 30;
const HISTORY_MAX_SELECTED = 10;
const ADJUDICATION_CANDIDATE_LIMIT = 8;
const RERANK_CANDIDATE_TEXT_MAX_CHARS = 500;
const RECENT_CONTEXT_MESSAGE_LIMIT = 5;
const RECENT_CONTEXT_MESSAGE_MAX_CHARS = 400;
const RECENT_CONTEXT_TOTAL_MAX_CHARS = 2_000;
const MEMORY_DISCOVERY_FACT_EXTRACTION_MODEL_KEY = "memory_discovery_fact_extraction";
const MEMORY_RECALL_RERANK_MODEL_KEY = "memory_recall_rerank";

// ---------------------------------------------------------------------------
// Cheap LLM helper
// ---------------------------------------------------------------------------

async function cheapLLM(
  modelKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const config = getModelConfig(modelKey);
  const { text } = await generateText({
    ...config,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return text;
}

// Types
// ---------------------------------------------------------------------------

type MemoryFact = { content: string };
type FactExtractionResult = { facts: MemoryFact[]; parseOk: boolean };
type RecentConversationMessage = {
  type: string;
  payload?: unknown;
};
type EventEmbeddingDoc = {
  _id: Id<"event_embeddings">;
  ownerId: string;
  conversationId: Id<"conversations">;
  content: string;
  timestamp: number;
  type: "user_message" | "assistant_message";
};
type MemoryDoc = {
  _id: Id<"memories">;
  content: string;
  accessCount?: number;
};
type RecallCandidate = {
  id: string;
  content: string;
  timestamp?: number;
  type?: string;
};

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

const extractJsonObject = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1).trim();
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n\n... (truncated)`;

const parseRerankSelection = (
  response: string,
  candidates: RecallCandidate[],
): string[] => {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate.id]));
  const byOrdinal = new Map(candidates.map((candidate, index) => [index + 1, candidate.id]));

  const toId = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return byOrdinal.get(Math.floor(value)) ?? null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (byId.has(trimmed)) return trimmed;
      const asNumber = Number(trimmed);
      if (Number.isFinite(asNumber)) {
        return byOrdinal.get(Math.floor(asNumber)) ?? null;
      }
    }
    return null;
  };

  const parsePayload = (payload: unknown): string[] => {
    if (!payload || typeof payload !== "object") return [];
    const selected = (payload as { selected?: unknown }).selected;
    if (!Array.isArray(selected)) return [];
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of selected) {
      const id = toId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    return deduped;
  };

  const trimmed = response.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const direct = parsePayload(parsed);
    if (direct.length > 0) return direct;
  } catch {
    // Continue to object extraction path
  }

  const objectBlock = extractJsonObject(trimmed);
  if (!objectBlock) return [];
  try {
    const parsed = JSON.parse(objectBlock);
    return parsePayload(parsed);
  } catch {
    return [];
  }
};

const RERANK_SELECTION_PROMPT = `You select the most relevant recall candidates for a query.

Return ONLY valid JSON in this shape:
{"selected":[1,2,3]}

Rules:
- Use candidate ordinals from the list.
- Use recent conversation context to infer intent behind the query.
- Select only truly relevant entries.
- Prefer precision over recall.
- If none are relevant, return {"selected":[]}.`;

const selectRelevantCandidateIds = async (args: {
  query: string;
  source: "memory" | "history";
  conversationContext?: string;
  candidates: RecallCandidate[];
  maxSelected: number;
}): Promise<string[]> => {
  if (args.candidates.length === 0) return [];
  const candidateText = args.candidates
    .map((candidate, index) => {
      const parts = [
        `[${index + 1}]`,
        `id=${candidate.id}`,
      ];
      if (candidate.type) {
        parts.push(`type=${candidate.type}`);
      }
      if (typeof candidate.timestamp === "number") {
        parts.push(`timestamp=${new Date(candidate.timestamp).toISOString()}`);
      }
      parts.push(`content=${truncate(candidate.content, RERANK_CANDIDATE_TEXT_MAX_CHARS)}`);
      return parts.join(" | ");
    })
    .join("\n");

  const response = await cheapLLM(
    MEMORY_RECALL_RERANK_MODEL_KEY,
    RERANK_SELECTION_PROMPT,
    [
      `Source: ${args.source}`,
      "Recent Conversation Context:",
      args.conversationContext?.trim() || "Unavailable.",
      "",
      `Search Query: ${args.query}`,
      "",
      "Candidates:",
      candidateText,
      "",
      `Maximum selections: ${args.maxSelected}`,
    ].join("\n"),
  );

  const selectedIds = parseRerankSelection(response, args.candidates);
  if (selectedIds.length <= args.maxSelected) {
    return selectedIds;
  }
  return selectedIds.slice(0, args.maxSelected);
};

const selectRecallDocs = async <TDoc extends { _id: unknown }>(args: {
  query: string;
  source: "memory" | "history";
  conversationContext?: string;
  docs: TDoc[];
  maxSelected: number;
  fallbackCount?: number;
  toCandidate: (doc: TDoc) => RecallCandidate;
}): Promise<TDoc[]> => {
  if (args.docs.length === 0) {
    return [];
  }

  const docsByCandidateId = new Map<string, TDoc>();
  const rerankCandidates = args.docs.map((doc) => {
    const candidate = args.toCandidate(doc);
    docsByCandidateId.set(candidate.id, doc);
    return candidate;
  });

  const selectedIds = await selectRelevantCandidateIds({
    query: args.query,
    source: args.source,
    conversationContext: args.conversationContext,
    candidates: rerankCandidates,
    maxSelected: args.maxSelected,
  });

  const selectedCandidateIds = selectedIds;

  return selectedCandidateIds
    .map((id) => docsByCandidateId.get(id))
    .filter((doc): doc is TDoc => !!doc);
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ADJUDICATION_PROMPT = `You adjudicate a new memory fact against existing similar facts.

Your goal is to decide if the new fact:
1. Is a "duplicate" (already fully captured by an existing fact).
2. "updates" an existing fact (the new fact contradicts, refines, or updates an existing fact, so the existing fact should be overwritten with a new combined/updated truth).
3. Is a completely "new_fact" (unrelated to the existing facts).

Return ONLY valid JSON in this shape:
{"action":"duplicate","memoryId":"..."}
OR
{"action":"update_existing","memoryId":"...","updatedContent":"..."}
OR
{"action":"new_fact"}

Rules:
- If duplicate, provide the exact id of the matching existing fact.
- If update_existing, provide the exact id of the fact to update, and the new updatedContent.
- If new_fact, do not provide an id or content.
- Be conservative with "duplicate": only say duplicate if the meaning is fully captured.
- Use "update_existing" for changing preferences (e.g., "likes blue" -> "likes red").`;

export type AdjudicationResult =
  | { action: "duplicate"; memoryId: string }
  | { action: "update_existing"; memoryId: string; updatedContent: string }
  | { action: "new_fact" };

export const parseAdjudicationResponse = (response: string): AdjudicationResult => {
  try {
    const parsed = JSON.parse(extractJsonObject(response) || response.trim());
    if (parsed.action === "duplicate" && typeof parsed.memoryId === "string") {
      return { action: "duplicate", memoryId: parsed.memoryId };
    }
    if (
      parsed.action === "update_existing" &&
      typeof parsed.memoryId === "string" &&
      typeof parsed.updatedContent === "string"
    ) {
      return {
        action: "update_existing",
        memoryId: parsed.memoryId,
        updatedContent: parsed.updatedContent,
      };
    }
  } catch (err) {
    console.warn("[memory] Failed to parse adjudication response, defaulting to new_fact:", response, err);
  }
  return { action: "new_fact" };
};

// ---------------------------------------------------------------------------
// insertMemory (internal mutation)
// ---------------------------------------------------------------------------

export const insertMemory = internalMutation({
  args: {
    ownerId: v.string(),
    conversationId: v.optional(v.id("conversations")),
    content: v.string(),
  },
  returns: v.id("memories"),
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("memories", {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      content: args.content,
      accessCount: 0,
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
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.memoryId, {
      content: args.content,
      accessedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// touchMemoriesById (internal mutation) — update accessedAt for used memories
// ---------------------------------------------------------------------------

export const touchMemoriesById = internalMutation({
  args: {
    touches: v.array(
      v.object({
        memoryId: v.id("memories"),
        currentAccessCount: v.optional(v.number()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await Promise.all(
      args.touches.map(async (touch) => {
        if (typeof touch.currentAccessCount === "number" && Number.isFinite(touch.currentAccessCount)) {
          await ctx.db.patch(touch.memoryId, {
            accessedAt: now,
            accessCount: touch.currentAccessCount + 1,
          });
          return;
        }

        const mem = await ctx.db.get(touch.memoryId);
        if (!mem) return;
        await ctx.db.patch(touch.memoryId, {
          accessedAt: now,
          accessCount: mem.accessCount + 1,
        });
      }),
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// getMemoryById (internal query)
// ---------------------------------------------------------------------------

const memoryDocValidator = v.object({
  _id: v.id("memories"),
  _creationTime: v.number(),
  ownerId: v.string(),
  conversationId: v.optional(v.id("conversations")),
  content: v.string(),
  accessCount: v.number(),
  accessedAt: v.number(),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
});

export const getMemoryById = internalQuery({
  args: { id: v.id("memories") },
  returns: v.union(v.null(), memoryDocValidator),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// ---------------------------------------------------------------------------
// getMemoriesByIds (internal query)
// ---------------------------------------------------------------------------

export const getMemoriesByIds = internalQuery({
  args: { ids: v.array(v.id("memories")) },
  returns: v.array(memoryDocValidator),
  handler: async (ctx, args) => {
    const results = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return results.filter((m): m is NonNullable<typeof m> => m !== null);
  },
});

// ---------------------------------------------------------------------------
// searchMemoriesByContent (internal query)
// ---------------------------------------------------------------------------

export const searchMemoriesByContent = internalQuery({
  args: {
    ownerId: v.string(),
    query: v.string(),
    limit: v.number(),
  },
  returns: v.array(memoryDocValidator),
  handler: async (ctx, args) => {
    const normalizedQuery = args.query.trim();
    if (!normalizedQuery) return [];

    return await ctx.db
      .query("memories")
      .withSearchIndex("search_content", (q) =>
        q.search("content", normalizedQuery).eq("ownerId", args.ownerId),
      )
      .take(args.limit);
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
// recallMemories (internal action) — BM25 recall + LLM rerank
// ---------------------------------------------------------------------------

export const recallMemories = internalAction({
  args: {
    ownerId: v.string(),
    query: v.string(),
    source: v.optional(v.union(v.literal("memory"), v.literal("history"))),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const query = args.query.trim();
    if (!query) return "";

    const source = args.source ?? "memory";

    try {
      let recentConversationContext = "";
      if (args.conversationId) {
        const conversation = await ctx.runQuery(internal.conversations.getById, {
          id: args.conversationId,
        });
        if (conversation?.ownerId === args.ownerId) {
          const recentMessages = await ctx.runQuery(internal.events.listRecentMessages, {
            conversationId: args.conversationId,
            limit: RECENT_CONTEXT_MESSAGE_LIMIT,
          });
          const contextLines = recentMessages
            .map((event: RecentConversationMessage) => {
              if (event.type !== "user_message" && event.type !== "assistant_message") {
                return null;
              }
              const payload =
                event.payload && typeof event.payload === "object"
                  ? (event.payload as { text?: unknown })
                  : {};
              const text = typeof payload.text === "string" ? payload.text.trim() : "";
              if (!text) {
                return null;
              }
              const speaker = event.type === "user_message" ? "User" : "Assistant";
              return `${speaker}: ${truncate(text, RECENT_CONTEXT_MESSAGE_MAX_CHARS)}`;
            })
            .filter((line: string | null): line is string => !!line);
          if (contextLines.length > 0) {
            recentConversationContext = truncate(
              contextLines.join("\n"),
              RECENT_CONTEXT_TOTAL_MAX_CHARS,
            );
          }
        }
      }

      if (source === "history") {
        const docs = (await ctx.runQuery(internal.data.event_embeddings.searchByContent, {
          ownerId: args.ownerId,
          query,
          limit: HISTORY_CANDIDATE_LIMIT,
          conversationId: args.conversationId,
        })) as EventEmbeddingDoc[];
        if (docs.length === 0) {
          return "";
        }

        const selectedDocs = await selectRecallDocs({
          query,
          source: "history",
          conversationContext: recentConversationContext,
          docs,
          maxSelected: HISTORY_MAX_SELECTED,
          toCandidate: (doc: EventEmbeddingDoc) => ({
            id: String(doc._id),
            content: doc.content,
            timestamp: doc.timestamp,
            type: doc.type,
          }),
        });

        if (selectedDocs.length === 0) {
          return "";
        }

        return selectedDocs
          .map((doc: EventEmbeddingDoc) => {
            const iso = new Date(doc.timestamp).toISOString();
            const speaker = doc.type === "user_message" ? "user" : "assistant";
            return `- [${iso}] (${speaker}) ${doc.content}`;
          })
          .join("\n");
      }

      const docs = (await ctx.runQuery(internal.data.memory.searchMemoriesByContent, {
        ownerId: args.ownerId,
        query,
        limit: RECALL_CANDIDATE_LIMIT,
      })) as MemoryDoc[];
      if (docs.length === 0) {
        return "";
      }

      const selectedDocs = await selectRecallDocs({
        query,
        source: "memory",
        conversationContext: recentConversationContext,
        docs,
        maxSelected: RECALL_MAX_SELECTED,
        toCandidate: (doc: MemoryDoc) => ({
          id: String(doc._id),
          content: doc.content,
        }),
      });

      if (selectedDocs.length === 0) {
        return "";
      }

      await ctx.runMutation(internal.data.memory.touchMemoriesById, {
        touches: selectedDocs.map((doc) => ({
          memoryId: doc._id as Id<"memories">,
          ...(typeof doc.accessCount === "number"
            ? { currentAccessCount: doc.accessCount }
            : {}),
        })),
      });

      return selectedDocs.map((doc: MemoryDoc) => `- ${doc.content}`).join("\n");
    } catch (err) {
      // best-effort: memory recall is supplementary context; returning empty degrades gracefully
      console.error("[memory] recallMemories failed:", err);
      return "";
    }
  },
});

// ---------------------------------------------------------------------------
// adjudicateAndStoreFact (internal action) — fact dedup/update/insert logic
// ---------------------------------------------------------------------------

export const adjudicateAndStoreFact = internalAction({
  args: {
    ownerId: v.string(),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    try {
      const docs = (await ctx.runQuery(internal.data.memory.searchMemoriesByContent, {
        ownerId: args.ownerId,
        query: args.content,
        limit: ADJUDICATION_CANDIDATE_LIMIT,
      })) as MemoryDoc[];

      if (docs.length === 0) {
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          content: args.content,
        });
        return "Memory saved.";
      }

      // We have similar items, adjudicate.
      const docsById = new Map(
        docs.map((doc: MemoryDoc) => [String(doc._id), doc]),
      );
      
      const candidateText = docs
        .map((doc: MemoryDoc, idx: number) => `[${idx + 1}] id=${doc._id} | content=${doc.content}`)
        .join("\\n");
      
      const promptBody = [
        "Existing Facts:",
        candidateText,
        "",
        "New Fact:",
        args.content
      ].join("\\n");

      const response = await cheapLLM(
        MEMORY_RECALL_RERANK_MODEL_KEY, // Reusing rerank model key for its good reasoning capabilities
        ADJUDICATION_PROMPT,
        promptBody
      );

      const decision = parseAdjudicationResponse(response);

      if (decision.action === "duplicate") {
        const existing = docsById.get(String(decision.memoryId));
        await ctx.runMutation(internal.data.memory.touchMemoriesById, {
          touches: [
            {
              memoryId: decision.memoryId as Id<"memories">,
              ...(typeof existing?.accessCount === "number"
                ? { currentAccessCount: existing.accessCount }
                : {}),
            },
          ],
        });
        return "Already captured.";
      }

      if (decision.action === "update_existing") {
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: decision.memoryId as Id<"memories">,
          content: decision.updatedContent,
        });
        return "Memory updated.";
      }

      // new_fact
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        content: args.content,
      });
      return "Memory saved.";
    } catch (err) {
      console.error("[memory] adjudicateAndStoreFact failed:", err);
      return `SaveMemory failed: ${(err as Error).message}`;
    }
  },
});

// ---------------------------------------------------------------------------
// saveMemory (internal action) — stable API surface for agent tool calls.
// Delegates to adjudicateAndStoreFact so tool callers don't couple to the
// adjudication implementation, which may gain pre-processing steps.
// ---------------------------------------------------------------------------

export const saveMemory = internalAction({
  args: {
    ownerId: v.string(),
    content: v.string(),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    return await ctx.runAction(internal.data.memory.adjudicateAndStoreFact, {
      ownerId: args.ownerId,
      content: args.content,
      conversationId: args.conversationId,
    });
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
    const response = await cheapLLM(
      MEMORY_DISCOVERY_FACT_EXTRACTION_MODEL_KEY,
      DISCOVERY_FACT_EXTRACTION_PROMPT,
      args.formattedSignals,
    );
    const { facts, parseOk } = parseFactResponse(response);

    if (!parseOk || facts.length === 0) {
      return null;
    }

    for (const fact of facts) {
      try {
        await ctx.runAction(internal.data.memory.adjudicateAndStoreFact, {
          ownerId: args.ownerId,
          content: fact.content,
        });
      } catch (err) {
        // best-effort: individual fact failure should not abort remaining facts in the batch
        console.error("[memory] seedFromDiscovery: error processing fact", err);
      }
    }

    return null;
  },
});
