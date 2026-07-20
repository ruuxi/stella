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
  SpawnReasoningEffort,
} from "../../contracts/agent-engine.js";
import { isRegisteredModelReference } from "../../ai/models.js";
import {
  isOpenEndedModelReference,
  isRegisteredBareStellaModelReference,
} from "../model-routing-matching.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, AgentRecord>;
  agentApi?: AgentToolApi;
  /**
   * Validates a plain model-reference string for spawn_agent. Throws with the
   * standard route-failure message when the model cannot be resolved.
   */
  validateSpawnModel?: (modelName: string) => void;
  /** Catalog-aware validation used for the final spawn decision. */
  validateSpawnModelWithMetadata?: (
    modelName: string,
    reasoningEffort?: SpawnReasoningEffort,
  ) => Promise<void>;
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
  return firstLine.length > 80
    ? `${firstLine.slice(0, 77).trimEnd()}...`
    : firstLine;
};

const logWorkingIndicatorTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};

/** Engine ids accepted in spawn_agent's `model` parameter. */
const SPAWN_ENGINE_IDS: Record<
  string,
  Exclude<AgentRuntimeEngine, "default">
> = {
  codex: "codex_cli",
  "claude-code": "claude_code_local",
};

export type SpawnModelSelection =
  | { kind: "default"; reasoningEffort?: SpawnReasoningEffort }
  | { kind: "model"; model: string; reasoningEffort?: SpawnReasoningEffort }
  | {
      kind: "engine";
      engine: SpawnEngineSelection;
      reasoningEffort?: SpawnReasoningEffort;
    };

const SPAWN_REASONING_EFFORTS = new Set<SpawnReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

const splitSpawnReasoningSuffix = (
  raw: string,
): { model: string; suffix: string } | undefined => {
  const colon = raw.lastIndexOf(":");
  if (colon === -1) return undefined;
  const model = raw.slice(0, colon).trim();
  const suffix = raw
    .slice(colon + 1)
    .trim()
    .toLowerCase();
  return { model, suffix };
};

const invalidSpawnReasoningSuffix = (suffix: string): Error =>
  new Error(
    `Invalid spawn_agent model reasoning suffix ":${suffix}". Expected one of :low, :medium, :high, or :xhigh. Open-ended gateway references keep colons verbatim; use default:<effort>, codex[/<model>]:<effort>, or claude-code[/<model>]:<effort> for unambiguous effort control.`,
  );

/**
 * Parses spawn_agent's optional `model` parameter:
 *
 *   - omitted / `default`            → the user's configured setup, untouched
 *   - `codex` / `claude-code`        → that engine with its configured model
 *   - `codex/<m>` / `claude-code/<m>`→ that engine with `<m>` pinned
 *   - anything else                  → plain model reference, resolved through
 *                                      the normal model-routing path
 *
 * Any non-omitted form may end in `:low`, `:medium`, `:high`, or `:xhigh`.
 */
export const parseSpawnAgentModel = (
  value: unknown,
  canResolveModel: (modelName: string) => boolean = () => false,
): SpawnModelSelection => {
  const raw = toOptionalString(value);
  if (!raw) return { kind: "default" };
  // Registered full model references win over suffix interpretation.
  // This preserves legitimate ids such as `...:thinking`, `...:free`, and
  // even a future registered model whose id literally ends in `:high`.
  const fullReferenceIsModel =
    isRegisteredModelReference(raw) || isOpenEndedModelReference(raw);
  const suffixParts = splitSpawnReasoningSuffix(raw);
  let modelReference = raw;
  let reasoningEffort: SpawnReasoningEffort | undefined;
  if (!fullReferenceIsModel && suffixParts) {
    const suffixIsEffort = SPAWN_REASONING_EFFORTS.has(
      suffixParts.suffix as SpawnReasoningEffort,
    );
    const slash = suffixParts.model.indexOf("/");
    const head = (
      slash === -1 ? suffixParts.model : suffixParts.model.slice(0, slash)
    ).toLowerCase();
    const baseIsKnownForm =
      suffixParts.model === "default" ||
      Boolean(SPAWN_ENGINE_IDS[head]) ||
      isRegisteredModelReference(suffixParts.model) ||
      isRegisteredBareStellaModelReference(suffixParts.model) ||
      canResolveModel(suffixParts.model);
    if (baseIsKnownForm && !suffixIsEffort) {
      throw invalidSpawnReasoningSuffix(suffixParts.suffix);
    }
    if (baseIsKnownForm && suffixIsEffort) {
      modelReference = suffixParts.model;
      reasoningEffort = suffixParts.suffix as SpawnReasoningEffort;
    }
  }
  if (modelReference === "default") {
    return { kind: "default", ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  const slash = modelReference.indexOf("/");
  // Engine ids are matched case-insensitively so `Codex/gpt-x` selects the
  // engine instead of falling through to a confusing route error.
  const head = (
    slash === -1 ? modelReference : modelReference.slice(0, slash)
  ).toLowerCase();
  const engine = SPAWN_ENGINE_IDS[head];
  if (engine) {
    const model =
      slash === -1 ? undefined : modelReference.slice(slash + 1).trim();
    return {
      kind: "engine",
      engine: { engine, ...(model ? { model } : {}) },
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  return {
    kind: "model",
    model: modelReference,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
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
  validateSpawnModelWithMetadata?: StateContext["validateSpawnModelWithMetadata"],
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  agentApi,
  validateSpawnModel,
  validateSpawnModelWithMetadata,
});

export const handleSendInput = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const threadId =
    toOptionalString(args.thread_id) ?? toOptionalString(context.agentId);
  const isManager = context.agentType === AGENT_IDS.MANAGER;
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
  const managerThreadId = isManager
    ? (toOptionalString(context.agentId) ??
      toOptionalString(context.cloudAgentId))
    : undefined;
  if (isManager && !managerThreadId) {
    return { error: "Manager thread identity is unavailable." };
  }
  if (managerThreadId && ctx.agentApi.adoptAgent) {
    const adoption = await ctx.agentApi.adoptAgent(threadId, managerThreadId);
    if (!adoption.adopted) {
      return { error: adoption.reason ?? `Thread not found: ${threadId}` };
    }
  }
  const delivered = await ctx.agentApi.sendAgentMessage(
    threadId,
    message,
    "orchestrator",
    {
      description,
      ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
      ...(managerThreadId ? { parentAgentId: managerThreadId } : {}),
      ...(context.agentType === AGENT_IDS.ORCHESTRATOR &&
      context.modelConfigSnapshot
        ? { modelConfigSnapshot: context.modelConfigSnapshot }
        : {}),
      deliveryKind: "external-input",
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

export const handleReport = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  if (context.agentType !== AGENT_IDS.MANAGER) {
    return { error: "Only a Manager can use report." };
  }
  const threadId =
    toOptionalString(context.agentId) ?? toOptionalString(context.cloudAgentId);
  if (!threadId) {
    return { error: "Manager thread identity is unavailable." };
  }
  const message = toOptionalString(args.message);
  if (!message) {
    return { error: "message is required" };
  }
  if (args.final !== undefined && typeof args.final !== "boolean") {
    return { error: "final must be a boolean" };
  }
  const final = args.final === true;
  const submitted = ctx.agentApi?.submitManagerReport?.(
    threadId,
    message,
    final,
  );
  if (!submitted?.accepted) {
    return {
      error: submitted?.reason ?? "Manager reporting is unavailable.",
    };
  }
  return {
    result: {
      thread_id: threadId,
      final,
      delivered: !final,
      accepted: true,
      note: final
        ? "The report is stored as the Manager's terminal result and will be delivered by the completion event."
        : "The report was delivered as a non-terminal update; the Manager remains active.",
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
      if (context.agentType === AGENT_IDS.MANAGER) {
        const managerThreadId =
          toOptionalString(context.agentId) ??
          toOptionalString(context.cloudAgentId);
        if (!managerThreadId) {
          return { error: "Manager thread identity is unavailable." };
        }
        if (ctx.agentApi.adoptAgent) {
          const adoption = await ctx.agentApi.adoptAgent(
            explicitThreadId,
            managerThreadId,
          );
          if (!adoption.adopted) {
            return {
              error: adoption.reason ?? `Thread not found: ${explicitThreadId}`,
            };
          }
        }
      }
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
    context.agentType === AGENT_IDS.MANAGER
      ? (toOptionalString(context.agentId) ??
        toOptionalString(context.cloudAgentId))
      : (toOptionalString(context.cloudAgentId) ??
        toOptionalString(context.agentId));
  const storageMode = context.storageMode ?? "local";
  const parentAgentDepth = Math.max(0, context.agentDepth ?? 0);
  const nextAgentDepth = parentAgentDepth + 1;
  const maxAgentDepth = context.maxAgentDepth;

  if (
    context.agentType !== AGENT_IDS.ORCHESTRATOR &&
    context.agentType !== AGENT_IDS.MANAGER
  ) {
    return {
      error: "Only the orchestrator or a manager can create tasks.",
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
  if (Object.prototype.hasOwnProperty.call(args, "group")) {
    return {
      error:
        "group has been removed from spawn_agent. Use spawn_manager to coordinate related multi-agent work.",
    };
  }

  let modelSelection: SpawnModelSelection;
  try {
    modelSelection = parseSpawnAgentModel(args.model, (modelName) => {
      if (!ctx.validateSpawnModel) return false;
      try {
        ctx.validateSpawnModel(modelName);
        return true;
      } catch {
        return false;
      }
    });
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (modelSelection.kind === "model") {
    // Fail the spawn loudly on an unroutable model — never silently fall
    // back to the configured default. A host without a validator can't
    // honor the override, which is also a loud failure, not a fallback.
    if (!ctx.validateSpawnModel && !ctx.validateSpawnModelWithMetadata) {
      return {
        error: `Cannot honor model "${modelSelection.model}": model routing is not available in this runtime. Omit the model parameter to use the configured default.`,
      };
    }
    try {
      if (ctx.validateSpawnModelWithMetadata) {
        await ctx.validateSpawnModelWithMetadata(
          modelSelection.model,
          modelSelection.reasoningEffort,
        );
      } else {
        ctx.validateSpawnModel?.(modelSelection.model);
      }
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
        ...(modelSelection.reasoningEffort
          ? { spawnReasoningEffort: modelSelection.reasoningEffort }
          : {}),
        rootRunId: context.rootRunId,
        agentDepth: nextAgentDepth,
        ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
        parentAgentId,
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

export const handleSpawnManager = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  if (context.agentType !== AGENT_IDS.ORCHESTRATOR) {
    return { error: "Only the orchestrator can create a manager." };
  }
  const prompt = toOptionalString(args.prompt);
  if (!prompt) {
    return { error: "prompt is required" };
  }
  const description = deriveAgentDescription("Task", prompt);
  const storageMode = context.storageMode ?? "local";
  if (ctx.agentApi) {
    if (!context.modelConfigSnapshot) {
      return {
        error:
          "The Orchestrator's resolved model configuration is unavailable; the Manager was not started.",
      };
    }
    const created = await ctx.agentApi.createAgent({
      conversationId: context.conversationId,
      description,
      prompt,
      agentType: AGENT_IDS.MANAGER,
      modelConfigSnapshot: context.modelConfigSnapshot,
      rootRunId: context.rootRunId,
      agentDepth: 1,
      storageMode,
    });
    return {
      result: {
        thread_id: created.threadId,
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        note: "Manager has started but is NOT finished yet. Use send_input with this thread_id only to steer it or provide needed outside input, then wait for a genuine blocker or its consolidated final report.",
      },
    };
  }

  const id = String(ctx.tasks.size + 1);
  ctx.tasks.set(id, {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    completedAt: null,
  });
  return {
    result: {
      thread_id: id,
      created: true,
      running_in_background: true,
      follow_up_on_completion: true,
      note: "Manager has started but is NOT finished yet. Use send_input with this thread_id only to steer it or provide needed outside input, then wait for a genuine blocker or its consolidated final report.",
    },
  };
};
