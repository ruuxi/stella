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
 * Eligibility: there must be unprocessed Dream-inbox rows (thread summaries,
 * memory notes, chronicle digests). `token_interval` additionally requires the
 * ~`tokenInterval` growth; `pre_compaction`, `startup_catchup`, and `manual`
 * run whenever anything is pending. Dream reads the durable inbox (not the
 * live transcript), so its cadence is independent of compaction — the
 * orchestrator already holds recent context in-window, so nothing needs to be
 * forced into durable memory until it grows past the interval or is about to
 * compact.
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
import { readHomePrompt } from "../prompts/home-prompts.js";

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

const stateFor = (stellaDataDir: string): DreamRuntimeState => {
  let state = RUNTIME_STATE.get(stellaDataDir);
  if (!state) {
    state = { inFlight: false, lastRunAt: 0, tokensAtLastRun: 0 };
    RUNTIME_STATE.set(stellaDataDir, state);
  }
  return state;
};

const lockDir = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "locks", "dream");

const acquireLock = (stellaDataDir: string): (() => void) | null => {
  const dir = lockDir(stellaDataDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
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
        return acquireLock(stellaDataDir);
      }
    } catch {
      // ignore
    }
    return null;
  }
};

const readDreamConfig = (stellaDataDir: string): DreamConfig => {
  const configPath = path.join(stellaDataDir, "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { dream?: Partial<DreamConfig> };
    const dream = parsed.dream ?? {};
    return {
      // Dream is on by default and consolidates the Dream inbox into the
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

export const buildDreamSystemPrompt = (stellaDataDir: string): string =>
  readHomePrompt(stellaDataDir, "dream-scheduled") ?? "";

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
  stellaDataDir: string;
  store: RuntimeStore;
  resolvedLlm: ResolvedLlmRoute;
}): Promise<void> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: args.stellaDataDir,
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

  await ensureDreamMemoryLayout(args.stellaDataDir);

  const tools = buildDreamTools();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: 'Run the Dream consolidation pass. Start by calling Dream with action="list".',
        },
      ],
      timestamp: Date.now(),
    },
  ];
  let totalToolCalls = 0;

  if (useClaudeCode) {
    try {
      const finalText = await runClaudeCodeAgentTextCompletion({
        stellaAppDir: args.stellaDataDir,
        agentType: AGENT_IDS.DREAM,
        stellaModel: args.resolvedLlm.model.id,
        context: {
          systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
          messages,
          tools,
        },
        executeTool: async (_toolCallId, toolName, toolArgs) => {
          totalToolCalls += 1;
          const dispatch = await dispatchLocalTool(toolName, toolArgs, {
            conversationId: "dream",
            store: {
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: { stellaDataDir: args.stellaDataDir },
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
      systemPrompt: buildDreamSystemPrompt(args.stellaDataDir),
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
              dreamInboxStore: args.store.dreamInboxStore,
            },
            dream: { stellaDataDir: args.stellaDataDir },
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
  stellaDataDir: string;
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
  pendingItems: number;
  detail?: string;
};

/**
 * Decide whether to fire a Dream run, then fire it asynchronously. Never
 * throws; never blocks the caller.
 */
export const maybeSpawnDreamRun = async (
  args: SpawnDreamArgs,
): Promise<SpawnDreamResult> => {
  const config = readDreamConfig(args.stellaDataDir);
  if (!config.enabled && args.trigger !== "manual") {
    return {
      scheduled: false,
      reason: "disabled",
      pendingItems: 0,
    };
  }

  const state = stateFor(args.stellaDataDir);
  if (state.inFlight) {
    return {
      scheduled: false,
      reason: "in_flight",
      pendingItems: 0,
    };
  }

  let pendingItems = 0;
  try {
    pendingItems = args.store.dreamInboxStore.countUnprocessed();
  } catch (error) {
    logger.debug("dream.count-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      scheduled: false,
      reason: "count_failed",
      pendingItems: 0,
    };
  }

  if (pendingItems === 0) {
    return {
      scheduled: false,
      reason: "no_inputs",
      pendingItems,
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
        pendingItems,
      };
    }
  }

  const apiKey = await getResolvedLlmApiKey(args.resolvedLlm);
  if (!apiKey && !resolvedLlmSupportsCredentiallessCalls(args.resolvedLlm)) {
    logger.debug("dream.skipped.no-api-key");
    return {
      scheduled: false,
      reason: "no_api_key",
      pendingItems,
    };
  }

  const release = acquireLock(args.stellaDataDir);
  if (!release) {
    logger.debug("dream.lock-busy");
    return {
      scheduled: false,
      reason: "lock_busy",
      pendingItems,
    };
  }
  state.inFlight = true;

  void runDream({
    stellaDataDir: args.stellaDataDir,
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
    pendingItems,
  };
};
