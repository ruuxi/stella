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

const RECALL_CANDIDATE_LIMIT = 30;
const RECALL_MAX_SELECTED = 8;
const HISTORY_CANDIDATE_LIMIT = 30;
const HISTORY_MAX_SELECTED = 10;
const RERANK_CANDIDATE_TEXT_MAX_CHARS = 500;
const RECENT_CONTEXT_MESSAGE_LIMIT = 5;
const RECENT_CONTEXT_MESSAGE_MAX_CHARS = 400;
const RECENT_CONTEXT_TOTAL_MAX_CHARS = 2_000;
const MEMORY_DISCOVERY_FACT_EXTRACTION_MODEL_KEY = "memory_discovery_fact_extraction";
const MEMORY_RECALL_RERANK_MODEL_KEY = "memory_recall_rerank";
const MEMORY_RECALL_QUERY_EMBEDDING_MODEL_KEY = "memory_recall_query_embedding";
const MEMORY_SAVE_EMBEDDING_MODEL_KEY = "memory_save_embedding";
const MEMORY_INGEST_EMBEDDING_MODEL_KEY = "memory_ingest_embedding";

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

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function embedText(modelKey: string, text: string): Promise<number[]> {
  const config = getModelConfig(modelKey);
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

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
};

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
  } catch {
    // Fallback to new_fact on parse error
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
      args.memoryIds.map(async (id) => {
        const mem = await ctx.db.get(id);
        if (!mem) return;
        await ctx.db.patch(id, {
          accessedAt: now,
          accessCount: (mem.accessCount ?? 0) + 1,
        });
      }),
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
// recallMemories (internal action) — vector search recall
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
            .map((event) => {
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
            .filter((line): line is string => !!line);
          if (contextLines.length > 0) {
            recentConversationContext = truncate(
              contextLines.join("\n"),
              RECENT_CONTEXT_TOTAL_MAX_CHARS,
            );
          }
        }
      }

      const vector = await embedText(MEMORY_RECALL_QUERY_EMBEDDING_MODEL_KEY, query);

      if (source === "history") {
        const candidates = await ctx.vectorSearch("event_embeddings", "by_embedding", {
          vector,
          limit: HISTORY_CANDIDATE_LIMIT,
          filter: (q) => q.eq("ownerId", args.ownerId),
        });
        if (candidates.length === 0) {
          return "";
        }

        const candidateIds = candidates.map((candidate) => candidate._id);
        const docs = await ctx.runQuery(internal.data.event_embeddings.getEmbeddingsByIds, {
          ids: candidateIds,
        });
        const docsById = new Map(
          docs
            .filter((doc: any) =>
              doc.ownerId === args.ownerId &&
              (!args.conversationId || doc.conversationId === args.conversationId)
            )
            .map((doc: any) => [String(doc._id), doc]),
        );
        const orderedDocs = candidateIds
          .map((id) => docsById.get(String(id)))
          .filter((doc): doc is NonNullable<typeof doc> => !!doc);

        const rerankCandidates: RecallCandidate[] = orderedDocs.map((doc: any) => ({
          id: String(doc._id),
          content: doc.content,
          timestamp: doc.timestamp,
          type: doc.type,
        }));
        const selectedIds = await selectRelevantCandidateIds({
          query,
          source: "history",
          conversationContext: recentConversationContext,
          candidates: rerankCandidates,
          maxSelected: HISTORY_MAX_SELECTED,
        });

        const selectedDocs = (selectedIds.length > 0 ? selectedIds : rerankCandidates.slice(0, 5).map((c) => c.id))
          .map((id) => docsById.get(id))
          .filter((doc): doc is NonNullable<typeof doc> => !!doc);

        if (selectedDocs.length === 0) {
          return "";
        }

        return selectedDocs
          .map((doc: any) => {
            const iso = new Date(doc.timestamp).toISOString();
            const speaker = doc.type === "user_message" ? "user" : "assistant";
            return `- [${iso}] (${speaker}) ${doc.content}`;
          })
          .join("\n");
      }

      const candidates = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: RECALL_CANDIDATE_LIMIT,
        filter: (q) => q.eq("ownerId", args.ownerId),
      });
      if (candidates.length === 0) {
        return "";
      }

      const candidateIds = candidates.map((candidate) => candidate._id);
      const docs = await ctx.runQuery(internal.data.memory.getMemoriesByIds, {
        ids: candidateIds,
      });
      const docsById = new Map(
        docs.map((doc) => [String(doc._id), doc]),
      );
      const orderedDocs = candidateIds
        .map((id) => docsById.get(String(id)))
        .filter((doc): doc is NonNullable<typeof doc> => !!doc);

      const rerankCandidates: RecallCandidate[] = orderedDocs.map((doc) => ({
        id: String(doc._id),
        content: doc.content,
      }));
      const selectedIds = await selectRelevantCandidateIds({
        query,
        source: "memory",
        conversationContext: recentConversationContext,
        candidates: rerankCandidates,
        maxSelected: RECALL_MAX_SELECTED,
      });

      const selectedDocs = (selectedIds.length > 0 ? selectedIds : rerankCandidates.slice(0, 5).map((c) => c.id))
        .map((id) => docsById.get(id))
        .filter((doc): doc is NonNullable<typeof doc> => !!doc);
      if (selectedDocs.length === 0) {
        return "";
      }

      await ctx.runMutation(internal.data.memory.touchMemoriesById, {
        memoryIds: selectedDocs.map((doc) => doc._id as Id<"memories">),
      });

      return selectedDocs.map((doc) => `- ${doc.content}`).join("\n");
    } catch (err) {
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
    embeddingModelKey: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    try {
      const vector = await embedText(args.embeddingModelKey, args.content);
      const similar = await ctx.vectorSearch("memories", "by_embedding", {
        vector,
        limit: 5,
        filter: (q) => q.eq("ownerId", args.ownerId),
      });

      if (similar.length === 0) {
        await ctx.runMutation(internal.data.memory.insertMemory, {
          ownerId: args.ownerId,
          conversationId: args.conversationId,
          content: args.content,
          embedding: vector,
        });
        return "Memory saved.";
      }

      // We have similar items, adjudicate.
      const candidateIds = similar.map((c) => c._id);
      const docs = await ctx.runQuery(internal.data.memory.getMemoriesByIds, { ids: candidateIds });
      
      const candidateText = docs.map((doc, idx) => `[${idx + 1}] id=${doc._id} | content=${doc.content}`).join("\\n");
      
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
        await ctx.runMutation(internal.data.memory.touchMemoriesById, {
          memoryIds: [decision.memoryId as Id<"memories">],
        });
        return "Already captured.";
      }

      if (decision.action === "update_existing") {
        const updatedVector = await embedText(args.embeddingModelKey, decision.updatedContent);
        await ctx.runMutation(internal.data.memory.mergeMemory, {
          memoryId: decision.memoryId as Id<"memories">,
          content: decision.updatedContent,
          embedding: updatedVector,
        });
        return "Memory updated.";
      }

      // new_fact
      await ctx.runMutation(internal.data.memory.insertMemory, {
        ownerId: args.ownerId,
        conversationId: args.conversationId,
        content: args.content,
        embedding: vector,
      });
      return "Memory saved.";
    } catch (err) {
      console.error("[memory] adjudicateAndStoreFact failed:", err);
      return `SaveMemory failed: ${(err as Error).message}`;
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
  handler: async (ctx, args): Promise<string> => {
    return await ctx.runAction(internal.data.memory.adjudicateAndStoreFact, {
      ownerId: args.ownerId,
      content: args.content,
      conversationId: args.conversationId,
      embeddingModelKey: MEMORY_SAVE_EMBEDDING_MODEL_KEY,
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
      console.log("[memory] seedFromDiscovery: no facts extracted", { parseOk, factCount: facts.length });
      return null;
    }

    console.log(`[memory] seedFromDiscovery: extracted ${facts.length} facts, inserting...`);

    for (const fact of facts) {
      try {
        await ctx.runAction(internal.data.memory.adjudicateAndStoreFact, {
          ownerId: args.ownerId,
          content: fact.content,
          embeddingModelKey: MEMORY_INGEST_EMBEDDING_MODEL_KEY,
        });
      } catch (err) {
        console.error("[memory] seedFromDiscovery: error processing fact", err);
      }
    }

    console.log("[memory] seedFromDiscovery: complete");
    return null;
  },
});

