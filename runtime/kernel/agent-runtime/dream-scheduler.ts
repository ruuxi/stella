/**
 * Dream Protocol scheduler.
 *
 * Dream consolidation is driven by orchestrator context growth, not by
 * per-event pings:
 *   - `token_interval`  — the orchestrator thread has grown ~`tokenInterval`
 *                         tokens since the last run (default 20k). Keeps
 *                         durable memory reasonably fresh during normal use.
 *   - `pre_compaction`  — the orchestrator thread is about to compact; flush a
 *                         consolidation so anything accumulated since the last
 *                         interval is folded before the middle is summarized.
 *   - `startup_catchup` — app just started; drain anything left over from a
 *                         previous session that ended before consolidating.
 *   - `manual`          — user clicked "Run Dream now".
 *
 * Eligibility: there must be pending inputs (thread_summaries +
 * memories_extensions files). `token_interval` additionally requires the
 * ~`tokenInterval` growth; `pre_compaction`, `startup_catchup`, and `manual`
 * run whenever anything is pending. Dream reads durable queues (not the live
 * transcript), so its cadence is independent of compaction — the orchestrator
 * already holds recent context in-window, so nothing needs to be forced into
 * durable memory until it grows past the interval or is about to compact.
 *
 * Single-flight: only one Dream run may execute at a time, via a mkdir lock
 * under `.stella/locks/dream/`.
 *
 * Fire-and-forget: callers `void maybeSpawnDreamRun(...)` and never await it.
 */

import fs from "node:fs";
import path from "node:path";

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../../ai/types.js";
import {
  countPendingDreamExtensions,
} from "../memory/dream-core.js";
import { ensureDreamMemoryLayout } from "../memory/dream-storage.js";
import {
  getResolvedLlmApiKey,
  resolvedLlmSupportsCredentiallessCalls,
  type ResolvedLlmRoute,
} from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { dispatchLocalTool } from "../tools/local-tool-dispatch.js";
import { dreamTool } from "../tools/defs/dream.js";
import { readTool } from "../tools/defs/read.js";
import { strReplaceTool } from "../tools/defs/str-replace.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";

const logger = createRuntimeLogger("agent-runtime.dream-scheduler");

const DEFAULT_TOKEN_INTERVAL = 20_000;
const MAX_ITERATIONS = 12;

type DreamConfig = {
  enabled: boolean;
  tokenInterval: number;
};

type DreamRuntimeState = {
  inFlight: boolean;
  lastRunAt: number;
  /** Orchestrator token estimate captured at the last Dream run. */
  tokensAtLastRun: number;
};

const RUNTIME_STATE = new Map<string, DreamRuntimeState>();

const stateFor = (stellaHome: string): DreamRuntimeState => {
  let state = RUNTIME_STATE.get(stellaHome);
  if (!state) {
    state = { inFlight: false, lastRunAt: 0, tokensAtLastRun: 0 };
    RUNTIME_STATE.set(stellaHome, state);
  }
  return state;
};

const lockDir = (stellaHome: string): string =>
  path.join(stellaHome, "locks", "dream");

const acquireLock = (stellaHome: string): (() => void) | null => {
  const dir = lockDir(stellaHome);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf-8",
    );
    return () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      logger.debug("dream.lock-error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    // Stale lock check: remove if older than 30 min.
    try {
      const stat = fs.statSync(dir);
      if (Date.now() - stat.mtimeMs > 30 * 60 * 1000) {
        fs.rmSync(dir, { recursive: true, force: true });
        return acquireLock(stellaHome);
      }
    } catch {
      // ignore
    }
    return null;
  }
};

const readDreamConfig = (stellaHome: string): DreamConfig => {
  const configPath = path.join(stellaHome, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { dream?: Partial<DreamConfig> };
    const dream = parsed.dream ?? {};
    return {
      // Dream is on by default and consolidates `thread_summaries` into the
      // durable on-disk memory layout. It is independent of Live Memory
      // (Chronicle screen capture); the only way it stays off is if the
      // user explicitly sets `dream.enabled: false` in `.stella/config.json`.
      enabled: dream.enabled !== false,
      tokenInterval:
        typeof dream.tokenInterval === "number" && dream.tokenInterval > 0
          ? Math.floor(dream.tokenInterval)
          : DEFAULT_TOKEN_INTERVAL,
    };
  } catch {
    return {
      enabled: true,
      tokenInterval: DEFAULT_TOKEN_INTERVAL,
    };
  }
};

const buildDreamSystemPrompt = (): string =>
  [
    "You are the Dream agent for Stella — a background memory consolidator.",
    "You never see the user. Your sole job is to fold unprocessed rollout summaries and capture-layer outputs into the durable on-disk memory layout under ~/.stella/memories/.",
    "",
    "Workflow:",
    "  1. Call Dream with action=\"list\" to see unprocessed thread_summaries and memories_extensions/* paths.",
    "  2. For each thread_summaries row: append a one-liner under raw_memories.md '## Unprocessed', then either insert a new task-group block at the top of MEMORY.md or extend an existing block. Move the raw_memories line to '## Processed'.",
    "  3. For each memories_extensions/<extension>/** path: read that extension's instructions.md path returned by Dream first, then fold the relevant signal into MEMORY.md.",
    "  4. After all rows are folded, refresh memory_summary.md to reflect the user's current active focus (~10-20 lines max).",
    "  5. Call Dream with action=\"markProcessed\" passing the threadKeys you handled and extensionPaths you consumed.",
    "",
    "Hard rules:",
    "  - Never invent rows. Only reference content the Dream tool actually returned.",
    "  - Never add prose, opinions, or speculation. Pure signal only.",
    "  - Never rewrite a whole file when a single block edit would do. StrReplace is your scalpel.",
    "  - If the list is empty, respond exactly 'Nothing to consolidate.' and stop. Do not call any tools.",
    "  - Stop after at most 12 tool calls per run. The scheduler will fire you again later if there is more.",
    "",
    "Final message: a single line summarizing what you did, e.g. 'Folded 3 rollouts into Task Group X; archived 1 stale block.'",
  ].join("\n");

const buildDreamTools = (): Tool[] =>
  [dreamTool, readTool, strReplaceTool].map((def) => ({
    name: def.name,
    description: def.description,
    parameters: def.parameters as Tool["parameters"],
  }));

const toToolResultMessage = (
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: toolCall.id,
  toolName: toolCall.name,
  isError,
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const runDream = async (args: {
  stellaHome: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
}): Promise<void> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaHome,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : await getResolvedLlmApiKey(args.resolvedLlm);
  if (
    !useClaudeCode &&
    !apiKey &&
    !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)
  ) {
    logger.debug("dream.skipped.no-api-key");
    return;
  }

  await ensureDreamMemoryLayout(args.stellaHome);

  const tools = buildDreamTools();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Run the Dream consolidation pass. Start by calling Dream with action=\"list\".",
        },
      ],
      timestamp: Date.now(),
    },
  ];
  let totalToolCalls = 0;

  if (useClaudeCode) {
    try {
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaRoot: args.stellaHome,
        agentType: AGENT_IDS.DREAM,
        stellaModel: args.resolvedLlm.model.id,
        context: {
          systemPrompt: buildDreamSystemPrompt(),
          messages,
          tools,
        },
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          totalToolCalls += 1;
          const dispatch = await dispatchLocalTool(toolName, toolArgs, {
            conversationId: "dream",
            store: {
              threadSummariesStore: args.store.threadSummariesStore,
            },
            dream: { stellaHome: args.stellaHome },
          });
          if (!dispatch.handled) {
            return {
              error: JSON.stringify({
                success: false,
                error: `Tool ${toolName} not available to the Dream agent.`,
              }),
            };
          }
          return { result: dispatch.text };
        },
      });
      logger.debug("dream.completed", {
        iterations: 1,
        toolCalls: totalToolCalls,
        finalText: finalText.slice(0, 80),
      });
    } catch (error) {
      logger.debug("dream.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const context: Context = {
      systemPrompt: buildDreamSystemPrompt(),
      messages,
      tools,
    };

    let response: AssistantMessage;
    try {
      response = await completeSimple(
        args.resolvedLlm.model,
        context,
        apiKey ? { apiKey } : undefined,
      );
    } catch (error) {
      logger.debug("dream.completeSimple.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    messages.push(response);

    const toolCalls = response.content.filter(
      (part): part is ToolCall => part.type === "toolCall",
    );

    if (toolCalls.length === 0) {
      logger.debug("dream.completed", {
        iterations: iteration + 1,
        toolCalls: totalToolCalls,
        finalText: readAssistantText(response).slice(0, 80),
      });
      return;
    }

    for (const toolCall of toolCalls) {
      totalToolCalls += 1;
      try {
        const dispatch = await dispatchLocalTool(
          toolCall.name,
          toolCall.arguments as Record<string, unknown>,
          {
            conversationId: "dream",
            store: {
              threadSummariesStore: args.store.threadSummariesStore,
            },
            dream: { stellaHome: args.stellaHome },
          },
        );
        if (!dispatch.handled) {
          messages.push(
            toToolResultMessage(
              toolCall,
              JSON.stringify({
                success: false,
                error: `Tool ${toolCall.name} not available to the Dream agent.`,
              }),
              true,
            ),
          );
          continue;
        }
        messages.push(toToolResultMessage(toolCall, dispatch.text, false));
      } catch (error) {
        messages.push(
          toToolResultMessage(
            toolCall,
            JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }),
            true,
          ),
        );
      }
    }
  }

  logger.debug("dream.iteration-cap", {
    iterations: MAX_ITERATIONS,
    toolCalls: totalToolCalls,
  });
};

export type SpawnDreamTrigger =
  | "token_interval"
  | "pre_compaction"
  | "startup_catchup"
  | "manual";

export type SpawnDreamArgs = {
  stellaHome: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
  trigger: SpawnDreamTrigger;
  /**
   * Orchestrator thread token estimate for this finalize. Required for
   * `token_interval` gating (growth since the last run); ignored by other
   * triggers, which run whenever anything is pending.
   */
  orchestratorTokenEstimate?: number;
};

export type SpawnDreamResultReason =
  | "scheduled"
  | "disabled"
  | "in_flight"
  | "count_failed"
  | "no_inputs"
  | "below_threshold"
  | "lock_busy"
  | "no_api_key"
  | "unavailable";

export type SpawnDreamResult = {
  scheduled: boolean;
  reason: SpawnDreamResultReason;
  pendingThreadSummaries: number;
  pendingExtensions: number;
  detail?: string;
};

/**
 * Decide whether to fire a Dream run, then fire it asynchronously. Never
 * throws; never blocks the caller.
 */
export const maybeSpawnDreamRun = async (
  args: SpawnDreamArgs,
): Promise<SpawnDreamResult> => {
  const config = readDreamConfig(args.stellaHome);
  if (!config.enabled && args.trigger !== "manual") {
    return {
      scheduled: false,
      reason: "disabled",
      pendingThreadSummaries: 0,
      pendingExtensions: 0,
    };
  }

  const state = stateFor(args.stellaHome);
  if (state.inFlight) {
    return {
      scheduled: false,
      reason: "in_flight",
      pendingThreadSummaries: 0,
      pendingExtensions: 0,
    };
  }

  let pendingThreadSummaries = 0;
  let pendingExtensions = 0;
  try {
    pendingThreadSummaries = args.store.threadSummariesStore.countUnprocessed();
    pendingExtensions = await countPendingDreamExtensions(args.stellaHome);
  } catch (error) {
    logger.debug("dream.count-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      scheduled: false,
      reason: "count_failed",
      pendingThreadSummaries: 0,
      pendingExtensions: 0,
    };
  }
  const totalPending = pendingThreadSummaries + pendingExtensions;

  if (totalPending === 0) {
    return {
      scheduled: false,
      reason: "no_inputs",
      pendingThreadSummaries,
      pendingExtensions,
    };
  }

  // `token_interval` is the only gated trigger; `pre_compaction`,
  // `startup_catchup`, and `manual` run whenever there is pending material.
  // The interval baseline follows compaction down: if the estimate dropped
  // below the last baseline (a compaction shrank the thread), reset the
  // baseline so growth is measured from the new floor rather than never
  // re-arming.
  if (args.trigger === "token_interval") {
    const estimate = args.orchestratorTokenEstimate;
    if (typeof estimate === "number" && estimate < state.tokensAtLastRun) {
      state.tokensAtLastRun = estimate;
    }
    const growth =
      typeof estimate === "number" ? estimate - state.tokensAtLastRun : 0;
    if (growth < config.tokenInterval) {
      return {
        scheduled: false,
        reason: "below_threshold",
        pendingThreadSummaries,
        pendingExtensions,
      };
    }
  }

  const apiKey = await getResolvedLlmApiKey(args.resolvedLlm);
  if (!apiKey && !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)) {
    logger.debug("dream.skipped.no-api-key");
    return {
      scheduled: false,
      reason: "no_api_key",
      pendingThreadSummaries,
      pendingExtensions,
    };
  }

  const release = acquireLock(args.stellaHome);
  if (!release) {
    logger.debug("dream.lock-busy");
    return {
      scheduled: false,
      reason: "lock_busy",
      pendingThreadSummaries,
      pendingExtensions,
    };
  }
  state.inFlight = true;

  void runDream({
    stellaHome: args.stellaHome,
    store: args.store,
    resolvedLlm: args.resolvedLlm,
  })
    .catch((error) => {
      logger.debug("dream.run-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      state.inFlight = false;
      state.lastRunAt = Date.now();
      if (typeof args.orchestratorTokenEstimate === "number") {
        state.tokensAtLastRun = args.orchestratorTokenEstimate;
      }
      release();
    });

  return {
    scheduled: true,
    reason: "scheduled",
    pendingThreadSummaries,
    pendingExtensions,
  };
};
