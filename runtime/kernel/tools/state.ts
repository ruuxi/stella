/**
 * State tools: spawn_agent / pause_agent and send_input handlers.
 */

import type {
  ToolContext,
  ToolResult,
  AgentRecord,
  AgentToolApi,
} from "./types.js";
import {
  THREAD_GROUP_KEY_PREFIX,
  deriveRuntimeThreadLiveState,
  formatRuntimeThreadAge,
  runtimeThreadLastActiveAt,
  type RuntimeThreadRecord,
} from "../runtime-threads.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../agents/local-agent-manager.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type {
  AgentRuntimeEngine,
  SpawnEngineSelection,
} from "../../contracts/agent-engine.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, AgentRecord>;
  agentApi?: AgentToolApi;
  /**
   * Validates a plain model-reference string for spawn_agent. Throws with the
   * standard route-failure message when the model cannot be resolved.
   */
  validateSpawnModel?: (modelName: string) => void;
};

const toOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const isGenericAgentDescription = (value: string): boolean =>
  /^(task|agent|work|help|do this|follow up)$/i.test(value.trim());

const deriveAgentDescription = (
  description: string,
  prompt: string,
): string => {
  if (description && !isGenericAgentDescription(description)) {
    return description;
  }
  const firstLine = prompt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^task\s*:\s*/i, "");
  if (!firstLine) {
    return description;
  }
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}...` : firstLine;
};

const logWorkingIndicatorTrace = (label: string, payload: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};

/** Engine ids accepted in spawn_agent's `model` parameter. */
const SPAWN_ENGINE_IDS: Record<string, Exclude<AgentRuntimeEngine, "default">> =
  {
    codex: "codex_cli",
    "claude-code": "claude_code_local",
  };

export type SpawnModelSelection =
  | { kind: "default" }
  | { kind: "model"; model: string }
  | { kind: "engine"; engine: SpawnEngineSelection };

/**
 * Parses spawn_agent's optional `model` parameter:
 *
 *   - omitted / `default`            → the user's configured setup, untouched
 *   - `codex` / `claude-code`        → that engine with its configured model
 *   - `codex/<m>` / `claude-code/<m>`→ that engine with `<m>` pinned
 *   - anything else                  → plain model reference, resolved through
 *                                      the normal model-routing path
 */
export const parseSpawnAgentModel = (value: unknown): SpawnModelSelection => {
  const raw = toOptionalString(value);
  if (!raw || raw === "default") return { kind: "default" };
  const slash = raw.indexOf("/");
  // Engine ids are matched case-insensitively so `Codex/gpt-x` selects the
  // engine instead of falling through to a confusing route error.
  const head = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
  const engine = SPAWN_ENGINE_IDS[head];
  if (engine) {
    const model = slash === -1 ? undefined : raw.slice(slash + 1).trim();
    return { kind: "engine", engine: { engine, ...(model ? { model } : {}) } };
  }
  return { kind: "model", model: raw };
};

const buildOtherThreadsResult = (
  threads: Array<
    Pick<
      RuntimeThreadRecord,
      | "threadId"
      | "description"
      | "lastUsedAt"
      | "agentStatus"
      | "agentUpdatedAt"
    >
  >,
  currentThreadId: string,
) =>
  threads
    .filter((thread) => thread.threadId !== currentThreadId)
    .map((thread) => ({
      thread_id: thread.threadId,
      // Live execution state from the same runtime signal as the "# Other
      // Threads" roster: "active" = executing a turn now, "paused" = idle
      // but resumable via send_input.
      status: deriveRuntimeThreadLiveState(thread),
      last_active: formatRuntimeThreadAge(runtimeThreadLastActiveAt(thread)),
      ...(thread.description ? { description: thread.description } : {}),
    }));

export const createStateContext = (
  stateRoot: string,
  agentApi?: AgentToolApi,
  validateSpawnModel?: (modelName: string) => void,
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  agentApi,
  validateSpawnModel,
});

export const handleSendInput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const threadId =
    toOptionalString(args.thread_id) ?? toOptionalString(context.agentId);
  const sender: "orchestrator" | "subagent" =
    context.agentType === "orchestrator" ? "orchestrator" : "subagent";
  if (!ctx.agentApi?.sendAgentMessage) {
    return { error: "Agent input is not configured on this device." };
  }
  if (!threadId) {
    return { error: "thread_id is required" };
  }
  const message = toOptionalString(args.message);
  if (!message) {
    return { error: "message is required" };
  }
  const rawDescription = toOptionalString(args.description);
  if (!rawDescription) {
    return { error: "description is required" };
  }
  const description = deriveAgentDescription(rawDescription, message);
  const delivered = await ctx.agentApi.sendAgentMessage(
    threadId,
    message,
    sender,
    {
      description,
      ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
    },
  );
  if (!delivered.delivered) {
    return { error: delivered.reason ?? `Thread not found: ${threadId}` };
  }
  return {
    result: {
      thread_id: threadId,
      status: "updated",
      delivered: true,
    },
  };
};

export const handleSpawnAgent = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const action = toOptionalString(args.action)?.toLowerCase();
  const explicitThreadId = toOptionalString(args.thread_id);

  if ((action === "cancel" || action === "stop") && explicitThreadId) {
    // Pin the cancel reason to a sentinel so the runner can recognize
    // orchestrator-initiated pause_agent and skip the hidden `[Task canceled]`
    // follow-up turn — that follow-up was clobbering the user-facing reply
    // because it produced an empty assistant message that overwrote the
    // orchestrator's actual response to the pause request.
    if (ctx.agentApi) {
      // Group ids and thread ids share one namespace (keys are minted
      // unique across both), so this routing can never hit both.
      if (
        explicitThreadId.startsWith(THREAD_GROUP_KEY_PREFIX) &&
        ctx.agentApi.cancelGroup
      ) {
        const groupResult = await ctx.agentApi.cancelGroup(
          explicitThreadId,
          AGENT_PAUSE_CANCEL_REASON,
        );
        if (groupResult.canceled) {
          return {
            result: {
              group_id: explicitThreadId,
              status: "canceled",
              canceled: true,
              canceled_thread_ids: groupResult.canceledThreadIds,
            },
          };
        }
        // Fall through: a grp-… prefix on a value that isn't a known
        // group still gets the per-thread lookup below.
      }
      const canceled = await ctx.agentApi.cancelAgent(
        explicitThreadId,
        AGENT_PAUSE_CANCEL_REASON,
      );
      if (!canceled.canceled) {
        return { error: `Thread not found: ${explicitThreadId}` };
      }
      return {
        result: {
          thread_id: explicitThreadId,
          status: "canceled",
          canceled: true,
        },
      };
    }
    const localRecord = ctx.tasks.get(explicitThreadId);
    if (!localRecord) return { error: `Thread not found: ${explicitThreadId}` };
    localRecord.status = "error";
    localRecord.error = AGENT_PAUSE_CANCEL_REASON;
    localRecord.completedAt = Date.now();
    return {
      result: {
        thread_id: explicitThreadId,
        status: "canceled",
        canceled: true,
      },
    };
  }

  const agentType = AGENT_IDS.GENERAL;
  const parentAgentId =
    toOptionalString(context.cloudAgentId) ??
    toOptionalString(context.agentId);
  const storageMode = context.storageMode ?? "local";
  const parentAgentDepth = Math.max(0, context.agentDepth ?? 0);
  const nextAgentDepth = parentAgentDepth + 1;
  const maxAgentDepth = context.maxAgentDepth;

  if (context.agentType !== AGENT_IDS.ORCHESTRATOR) {
    return {
      error: "Only the orchestrator can create tasks.",
    };
  }

  // agent_type was removed with the custom-agent-types story; error loudly
  // instead of silently ignoring a stale argument.
  if (toOptionalString(args.agent_type)) {
    return {
      error:
        "agent_type has been removed from spawn_agent. Every spawn runs the general agent; use the optional `model` parameter to pick a model or engine instead.",
    };
  }

  const modelSelection = parseSpawnAgentModel(args.model);
  if (modelSelection.kind === "model") {
    // Fail the spawn loudly on an unroutable model — never silently fall
    // back to the configured default. A host without a validator can't
    // honor the override, which is also a loud failure, not a fallback.
    if (!ctx.validateSpawnModel) {
      return {
        error: `Cannot honor model "${modelSelection.model}": model routing is not available in this runtime. Omit the model parameter to use the configured default.`,
      };
    }
    try {
      ctx.validateSpawnModel(modelSelection.model);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  if (typeof maxAgentDepth === "number" && nextAgentDepth > maxAgentDepth) {
    return {
      error: `Task depth limit reached (${maxAgentDepth}). Complete work in the current task instead of creating another subtask.`,
    };
  }

  const prompt = toOptionalString(args.prompt);
  if (!prompt) {
    return { error: "prompt is required" };
  }
  const rawDescription = toOptionalString(args.description);
  if (!rawDescription) {
    return { error: "description is required" };
  }
  const description = deriveAgentDescription(rawDescription, prompt);
  const group = toOptionalString(args.group);

  if (ctx.agentApi) {
    logWorkingIndicatorTrace("[stella:working-indicator:spawn_agent]", {
      conversationId: context.conversationId,
      rawDescription,
      description,
      promptPreview: prompt.slice(0, 160),
      rootRunId: context.rootRunId,
    });
    let created: Awaited<ReturnType<AgentToolApi["createAgent"]>>;
    try {
      created = await ctx.agentApi.createAgent({
        conversationId: context.conversationId,
        description,
        prompt,
        agentType,
        ...(modelSelection.kind === "model"
          ? { model: modelSelection.model }
          : {}),
        ...(modelSelection.kind === "model"
          ? { spawnEngine: { engine: "default" } as const }
          : {}),
        ...(modelSelection.kind === "engine"
          ? { spawnEngine: modelSelection.engine }
          : {}),
        rootRunId: context.rootRunId,
        agentDepth: nextAgentDepth,
        ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
        parentAgentId,
        ...(group ? { group } : {}),
        storageMode,
      });
    } catch (error) {
      // Group member caps and thread-resolution failures surface as tool
      // errors the model can act on, not as runner-level crashes.
      return { error: (error as Error).message };
    }
    const otherThreads = created.activeThreads
      ? buildOtherThreadsResult(created.activeThreads, created.threadId)
      : [];
    return {
      result: {
        thread_id: created.threadId,
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        ...(created.groupKey
          ? {
              group_id: created.groupKey,
              ...(created.groupLabel ? { group_label: created.groupLabel } : {}),
              group_note:
                "Reuse this exact group_id on sibling spawn_agent calls for the same request.",
            }
          : {}),
        note: "Task has started but is NOT finished yet. Wait for the completion event before telling the user it is done.",
        ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
      },
    };
  }

  // Fallback local in-memory task behavior (used only when no task manager is wired).
  const id = String(ctx.tasks.size + 1);
  const record: AgentRecord = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
  };
  ctx.tasks.set(id, record);
  const activeThreads = [...ctx.tasks.values()].slice(-16).map((task) => ({
    threadId: task.id,
    description: task.description,
    lastUsedAt: task.completedAt ?? task.startedAt,
    agentStatus: task.status,
  }));
  const otherThreads = buildOtherThreadsResult(activeThreads, id);
  return {
    result: {
      thread_id: id,
      created: true,
      running_in_background: true,
      follow_up_on_completion: true,
      note: "Task has started but is NOT finished yet. Wait for the completion event before telling the user it is done.",
      ...(otherThreads.length > 0 ? { other_threads: otherThreads } : {}),
    },
  };
};
