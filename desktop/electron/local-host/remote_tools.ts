/**
 * AI SDK tool() instances for remote/local memory-assisted operations.
 *
 * - Cloud mode: forwards tool calls to Convex actions.
 * - Local mode: uses a local SQLite BM25 memory store and Convex LLM proxy
 *   only for reranking.
 */

import { generateText, tool, type Tool } from "ai";
import { z } from "zod";
import { createProxiedModel } from "./agent_core/model_proxy.js";
import {
  LocalMemoryStore,
  type LocalHistoryMessage,
  type LocalMemoryCandidate,
  type LocalMemorySource,
} from "./local_memory_store.js";
import {
  localWebFetch,
  localActivateSkill,
  localNoResponse,
} from "./local_tool_overrides.js";

const LOCAL_RECALL_CANDIDATE_LIMIT = 30;
const LOCAL_RECALL_MAX_SELECTED = 8;
const LOCAL_HISTORY_MAX_SELECTED = 10;
const LOCAL_RECENT_CONTEXT_MESSAGE_LIMIT = 5;
const LOCAL_RECENT_CONTEXT_MESSAGE_MAX_CHARS = 400;
const LOCAL_RECENT_CONTEXT_TOTAL_MAX_CHARS = 2_000;
const RERANK_CANDIDATE_TEXT_MAX_CHARS = 500;

const RERANK_SELECTION_PROMPT = `You select the most relevant recall candidates for a query.

Return ONLY valid JSON in this shape:
{"selected":[1,2,3]}

Rules:
- Use candidate ordinals from the list.
- Use recent conversation context to infer intent behind the query.
- Select only truly relevant entries.
- Prefer precision over recall.
- If none are relevant, return {"selected":[]}.`;

type LocalMemoryConfig = {
  stellaHome: string;
  proxyBaseUrl: string;
  proxyToken: string;
  rerankModelId: string;
  localHistory?: LocalHistoryMessage[];
};

export type RemoteToolsOpts = {
  convexUrl: string;
  authToken: string;
  conversationId: string;
  agentType: string;
  mode?: "cloud" | "local";
  localMemory?: LocalMemoryConfig;
  /** Required for local tool overrides (ActivateSkill reads from disk) */
  stellaHome?: string;
};

type RecallCandidate = {
  id: string;
  content: string;
  role?: "user" | "assistant";
};

const localMemoryStores = new Map<string, LocalMemoryStore>();

const getLocalMemoryStore = (stellaHome: string): LocalMemoryStore => {
  const existing = localMemoryStores.get(stellaHome);
  if (existing) return existing;
  const created = new LocalMemoryStore(stellaHome);
  localMemoryStores.set(stellaHome, created);
  return created;
};

const truncate = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
};

const extractJsonObject = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1).trim();
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

const buildConversationContext = (
  localHistory: LocalHistoryMessage[] | undefined,
): string => {
  if (!localHistory || localHistory.length === 0) return "";
  const recent = localHistory.slice(-LOCAL_RECENT_CONTEXT_MESSAGE_LIMIT);
  const lines = recent
    .map((message) => {
      const text = message.content.trim();
      if (!text) return null;
      const speaker = message.role === "assistant" ? "Assistant" : "User";
      return `${speaker}: ${truncate(text, LOCAL_RECENT_CONTEXT_MESSAGE_MAX_CHARS)}`;
    })
    .filter((line: string | null): line is string => !!line);
  if (lines.length === 0) return "";
  return truncate(lines.join("\n"), LOCAL_RECENT_CONTEXT_TOTAL_MAX_CHARS);
};

const selectRelevantLocalCandidateIds = async (args: {
  proxyBaseUrl: string;
  proxyToken: string;
  modelId: string;
  query: string;
  source: LocalMemorySource;
  conversationContext: string;
  candidates: RecallCandidate[];
  maxSelected: number;
}): Promise<string[]> => {
  if (args.candidates.length === 0) return [];

  const model = createProxiedModel(args.proxyBaseUrl, args.proxyToken, args.modelId);
  const candidateText = args.candidates
    .map((candidate, index) => {
      const parts = [`[${index + 1}]`, `id=${candidate.id}`];
      if (candidate.role) {
        parts.push(`role=${candidate.role}`);
      }
      parts.push(`content=${truncate(candidate.content, RERANK_CANDIDATE_TEXT_MAX_CHARS)}`);
      return parts.join(" | ");
    })
    .join("\n");

  const { text } = await generateText({
    model,
    system: RERANK_SELECTION_PROMPT,
    messages: [{
      role: "user",
      content: [
        `Source: ${args.source}`,
        "Recent Conversation Context:",
        args.conversationContext || "Unavailable.",
        "",
        `Search Query: ${args.query}`,
        "",
        "Candidates:",
        candidateText,
        "",
        `Maximum selections: ${args.maxSelected}`,
      ].join("\n"),
    }],
  });

  const selectedIds = parseRerankSelection(text, args.candidates);
  if (selectedIds.length <= args.maxSelected) {
    return selectedIds;
  }
  return selectedIds.slice(0, args.maxSelected);
};

async function callConvexAction(
  opts: RemoteToolsOpts,
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = opts.convexUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.authToken}`,
    },
    body: JSON.stringify({ path, args }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Convex action ${path} failed (${response.status}): ${text}`);
  }

  return await response.json();
}

async function callBackendTool(
  opts: RemoteToolsOpts,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<string> {
  const result = await callConvexAction(opts, "agent/local_runtime:executeTool", {
    toolName,
    toolArgs,
    conversationId: opts.conversationId,
    agentType: opts.agentType,
  });
  return typeof result === "string" ? result : JSON.stringify(result);
}

const looseObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();

const createLocalRecallTools = (opts: RemoteToolsOpts): Record<string, Tool<any, any>> => {
  const config = opts.localMemory;
  if (!config) {
    return {
      RecallMemories: tool({
        description: "Look up local memories.",
        inputSchema: z.object({
          query: z.string().describe("Search query for memory recall"),
          source: z.enum(["memory", "history"]).optional(),
          limit: z.number().optional().describe("Max results to return"),
        }),
        execute: async () => "Local memory is unavailable: missing runtime configuration.",
      }),
      SaveMemory: tool({
        description: "Save a local memory entry.",
        inputSchema: z.object({ content: z.string().describe("Memory content") }),
        execute: async () => "Local memory is unavailable: missing runtime configuration.",
      }),
    };
  }

  const store = getLocalMemoryStore(config.stellaHome);
  store.ingestHistoryMessages(opts.conversationId, config.localHistory ?? []);
  const recallCache = new Map<string, string>();
  const recentConversationContext = buildConversationContext(config.localHistory);

  return {
    RecallMemories: tool({
      description: "Search local memory and local history for relevant context.",
      inputSchema: z.object({
        query: z.string().describe("Search query for memory recall"),
        source: z.enum(["memory", "history"]).optional(),
        limit: z.number().optional().describe("Max candidates before rerank"),
      }),
      execute: async (args: { query: string; source?: LocalMemorySource; limit?: number }) => {
        const source = args.source ?? "memory";
        const normalizedQuery = args.query.trim();
        if (!normalizedQuery) {
          return "No relevant memories found.";
        }

        const cacheKey = `${source}::${normalizedQuery}::${args.limit ?? "default"}`;
        const cached = recallCache.get(cacheKey);
        if (cached) return cached;

        const candidates = store.search({
          conversationId: opts.conversationId,
          source,
          query: normalizedQuery,
          limit: args.limit ?? LOCAL_RECALL_CANDIDATE_LIMIT,
        });
        if (candidates.length === 0) {
          const none = "No relevant memories found.";
          recallCache.set(cacheKey, none);
          return none;
        }

        const recallCandidates: RecallCandidate[] = candidates.map((candidate) => ({
          id: String(candidate.id),
          content: candidate.content,
          ...(candidate.role ? { role: candidate.role } : {}),
        }));

        let selectedIds: string[] = [];
        try {
          selectedIds = await selectRelevantLocalCandidateIds({
            proxyBaseUrl: config.proxyBaseUrl,
            proxyToken: config.proxyToken,
            modelId: config.rerankModelId,
            query: normalizedQuery,
            source,
            conversationContext: recentConversationContext,
            candidates: recallCandidates,
            maxSelected: source === "history" ? LOCAL_HISTORY_MAX_SELECTED : LOCAL_RECALL_MAX_SELECTED,
          });
        } catch (error) {
          selectedIds = [];
          console.error("[remote_tools] local recall rerank failed:", error);
        }

        const docsById = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));
        const selectedDocs = (selectedIds.length > 0
          ? selectedIds
          : recallCandidates.slice(0, 5).map((candidate) => candidate.id))
          .map((id) => docsById.get(id))
          .filter((doc): doc is LocalMemoryCandidate => !!doc);

        if (selectedDocs.length === 0) {
          const none = "No relevant memories found.";
          recallCache.set(cacheKey, none);
          return none;
        }

        if (source === "memory") {
          store.touch(selectedDocs.map((doc) => doc.id));
        }

        const text = source === "history"
          ? selectedDocs
            .map((doc) => {
              const speaker = doc.role === "assistant" ? "assistant" : "user";
              return `- (${speaker}) ${doc.content}`;
            })
            .join("\n")
          : selectedDocs.map((doc) => `- ${doc.content}`).join("\n");
        recallCache.set(cacheKey, text);
        return text;
      },
    }),

    SaveMemory: tool({
      description: "Save an important fact or insight to local long-term memory",
      inputSchema: z.object({
        content: z.string().describe("The memory content to save"),
      }),
      execute: async (args: { content: string }) => {
        const content = args.content.trim();
        if (!content) {
          return "Memory content cannot be empty.";
        }
        store.saveMemory(opts.conversationId, content);
        return "Memory saved.";
      },
    }),
  };
};

export function createRemoteTools(opts: RemoteToolsOpts): Record<string, Tool<any, any>> {
  // Local mode: only memory tools needed (all execution is local)
  if ((opts.mode ?? "cloud") === "local") {
    return createLocalRecallTools(opts);
  }

  // Cloud mode: use local implementations for tools that don't need the server,
  // keep server passthroughs for tools that require secrets/server resources.

  const passthroughTool = (
    toolName: string,
    description: string,
    inputSchema: z.ZodType<Record<string, unknown>>,
  ): Tool<any, any> =>
    tool({
      description,
      inputSchema,
      execute: async (args: Record<string, unknown>) => {
        try {
          return await callBackendTool(opts, toolName, args);
        } catch (error) {
          return `${toolName} failed: ${(error as Error).message}`;
        }
      },
    });

  // Always use local memory — desktop is online when these tools are called
  const localRecallTools = createLocalRecallTools(opts);

  return {
    // ── Local tools (no server round-trip) ──

    RecallMemories: localRecallTools.RecallMemories,
    SaveMemory: localRecallTools.SaveMemory,

    WebFetch: tool({
      description: "Fetch content from a URL",
      inputSchema: z.object({
        url: z.string().describe("URL to fetch"),
        prompt: z.string().optional().describe("What to extract from the page"),
      }),
      execute: async (args: { url: string; prompt?: string }) => {
        return await localWebFetch(args);
      },
    }),

    ActivateSkill: tool({
      description: "Load a skill's full instructions by ID",
      inputSchema: z.object({
        skillId: z.string().describe("The skill ID to activate"),
      }),
      execute: async (args: { skillId: string }) => {
        if (opts.stellaHome) {
          return await localActivateSkill({ skillId: args.skillId, stellaHome: opts.stellaHome });
        }
        // Fallback to server if stellaHome not provided
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:activateSkill", {
            skillId: args.skillId,
          });
          if (!result || typeof result !== "string") {
            return `Skill '${args.skillId}' not found or has no content.`;
          }
          return result;
        } catch (error) {
          return `Failed to activate skill: ${(error as Error).message}`;
        }
      },
    }),

    NoResponse: tool({
      description: "Suppress user-facing response for this turn.",
      inputSchema: looseObject({}) as z.ZodType<Record<string, unknown>>,
      execute: async () => {
        return await localNoResponse();
      },
    }),

    // ── Server passthroughs (require secrets/server resources) ──

    WebSearch: tool({
      description: "Search the web for information",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        maxResults: z.number().optional(),
      }),
      execute: async (args: { query: string; maxResults?: number }) => {
        try {
          const result = await callConvexAction(opts, "agent/local_runtime:webSearch", {
            query: args.query,
            conversationId: opts.conversationId,
            agentType: opts.agentType,
          });
          return typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) {
          return `WebSearch failed: ${(error as Error).message}`;
        }
      },
    }),

    IntegrationRequest: passthroughTool(
      "IntegrationRequest",
      "Call an external integration endpoint securely via server-side secret handling.",
      looseObject({
        provider: z.string().optional(),
        endpoint: z.string().optional(),
        mode: z.string().optional(),
        secretId: z.string().optional(),
        request: z.record(z.string(), z.unknown()).optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),

    HeartbeatGet: passthroughTool(
      "HeartbeatGet",
      "Get current heartbeat automation configuration.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    HeartbeatUpsert: passthroughTool(
      "HeartbeatUpsert",
      "Create or update heartbeat automation settings.",
      looseObject({
        schedule: z.string().optional(),
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    HeartbeatRun: passthroughTool(
      "HeartbeatRun",
      "Run heartbeat automation now.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),

    CronList: passthroughTool(
      "CronList",
      "List cron automations.",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
    CronAdd: passthroughTool(
      "CronAdd",
      "Create a cron automation.",
      looseObject({
        schedule: z.string().optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        enabled: z.boolean().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronUpdate: passthroughTool(
      "CronUpdate",
      "Update an existing cron automation.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
        schedule: z.string().optional(),
        message: z.string().optional(),
        title: z.string().optional(),
        enabled: z.boolean().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronRemove: passthroughTool(
      "CronRemove",
      "Remove a cron automation.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    CronRun: passthroughTool(
      "CronRun",
      "Run a cron automation immediately.",
      looseObject({
        id: z.string().optional(),
        cronId: z.string().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),

    StoreSearch: passthroughTool(
      "StoreSearch",
      "Search the Stella store for packages.",
      looseObject({
        query: z.string().optional(),
        limit: z.number().optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    GenerateApiSkill: passthroughTool(
      "GenerateApiSkill",
      "Generate and save an API integration skill from discovered endpoint specs.",
      looseObject({
        service: z.string().optional(),
        endpoints: z.array(z.record(z.string(), z.unknown())).optional(),
      }) as z.ZodType<Record<string, unknown>>,
    ),
    ListResources: passthroughTool(
      "ListResources",
      "List available resources (local/cloud/connectors).",
      looseObject({}) as z.ZodType<Record<string, unknown>>,
    ),
  };
}

