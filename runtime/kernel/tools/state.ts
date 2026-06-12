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
  WORKFLOW_AGENT_TYPE,
  formatRuntimeThreadAge,
  type RuntimeThreadRecord,
} from "../runtime-threads.js";
import { AGENT_PAUSE_CANCEL_REASON } from "../agents/local-agent-manager.js";
import {
  AGENT_IDS,
  isOrchestratorReservedBuiltinAgentId,
} from "../../contracts/agent-runtime.js";

export type StateContext = {
  stateRoot: string;
  tasks: Map<string, AgentRecord>;
  agentApi?: AgentToolApi;
  getSubagentTypes?: () => readonly string[];
  searchThreads?: (args: {
    conversationId: string;
    query?: string;
    limit?: number;
  }) => RuntimeThreadRecord[];
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

export const getAvailableSubagentTypes = (
  getSubagentTypes?: () => readonly string[],
): readonly string[] => {
  const seen = new Set<string>();
  const subagentTypes: string[] = [];
  for (const agentType of getSubagentTypes?.() ?? []) {
    if (isOrchestratorReservedBuiltinAgentId(agentType) || seen.has(agentType)) {
      continue;
    }
    seen.add(agentType);
    subagentTypes.push(agentType);
  }
  if (!seen.has(AGENT_IDS.GENERAL)) {
    subagentTypes.unshift(AGENT_IDS.GENERAL);
  }
  return subagentTypes;
};

const buildOtherThreadsResult = (
  threads: Array<Pick<RuntimeThreadRecord, "threadId" | "description" | "lastUsedAt">>,
  currentThreadId: string,
) =>
  threads
    .filter((thread) => thread.threadId !== currentThreadId)
    .map((thread) => ({
      thread_id: thread.threadId,
      availability: "resumable",
      last_used: formatRuntimeThreadAge(thread.lastUsedAt),
      ...(thread.description ? { description: thread.description } : {}),
    }));

export const createStateContext = (
  stateRoot: string,
  agentApi?: AgentToolApi,
  getSubagentTypes?: () => readonly string[],
  searchThreads?: StateContext["searchThreads"],
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  agentApi,
  getSubagentTypes,
  searchThreads,
});

export const handleSearchThreads = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  if (!ctx.searchThreads) {
    return { error: "Thread search is not available on this device." };
  }
  const query = toOptionalString(args.query);
  const rawLimit = typeof args.limit === "number" ? args.limit : undefined;
  const limit = Math.max(1, Math.min(25, Math.floor(rawLimit ?? 12)));
  const threads = ctx.searchThreads({
    conversationId: context.conversationId,
    ...(query ? { query } : {}),
    limit,
  });
  if (threads.length === 0) {
    return {
      result: {
        threads: [],
        note: query
          ? "No past work matched. Try fewer or different words, or call again without a query to browse recent work."
          : "No past work recorded yet.",
      },
    };
  }
  return {
    result: {
      threads: threads.map((thread) => ({
        thread_id: thread.threadId,
        availability:
          thread.agentType === WORKFLOW_AGENT_TYPE
            ? "workflow — cannot take send_input; start a new workflow for follow-ups"
            : "resumable",
        last_used: formatRuntimeThreadAge(thread.lastUsedAt),
        ...(thread.name && thread.name !== thread.threadId
          ? { name: thread.name }
          : {}),
        ...(thread.description ? { description: thread.description } : {}),
        ...(thread.summary
          ? { summary: thread.summary.replace(/\s+/g, " ").slice(0, 300) }
          : {}),
        ...(thread.groupKey ? { group_id: thread.groupKey } : {}),
        ...(thread.groupLabel ? { group_label: thread.groupLabel } : {}),
      })),
    },
  };
};

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

export const handleRunWorkflow = async (
  ctx: StateContext,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  if (context.agentType !== AGENT_IDS.ORCHESTRATOR) {
    return { error: "Only the orchestrator can run workflows." };
  }
  if (!ctx.agentApi?.runWorkflow) {
    return { error: "Workflows are not available on this device." };
  }
  const script = toOptionalString(args.script);
  if (!script) {
    return { error: "script is required" };
  }
  const rawDescription = toOptionalString(args.description);
  if (!rawDescription) {
    return { error: "description is required" };
  }
  // Never derive from the script — its first line is JavaScript, and the
  // description becomes the workflow's user-facing name.
  const description = rawDescription;
  const group = toOptionalString(args.group);
  try {
    const started = await ctx.agentApi.runWorkflow({
      conversationId: context.conversationId,
      description,
      script,
      ...(group ? { group } : {}),
      ...(context.rootRunId ? { rootRunId: context.rootRunId } : {}),
    });
    return {
      result: {
        workflow_id: started.workflowId,
        created: true,
        running_in_background: true,
        follow_up_on_completion: true,
        ...(started.groupKey
          ? {
              group_id: started.groupKey,
              ...(started.groupLabel
                ? { group_label: started.groupLabel }
                : {}),
            }
          : {}),
        note: "Workflow started but is NOT finished yet. You will receive one [Agent completed] event on this workflow_id carrying the script's return value. Do not tell the user it is done until then. pause_agent stops it; it cannot take send_input.",
      },
    };
  } catch (error) {
    // Script syntax errors land here with V8 line info — return them so
    // the orchestrator can fix the script and retry.
    return { error: (error as Error).message };
  }
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

  const agentType = toOptionalString(args.agent_type) ?? AGENT_IDS.GENERAL;
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

  const subagentTypes = getAvailableSubagentTypes(ctx.getSubagentTypes);
  if (
    isOrchestratorReservedBuiltinAgentId(agentType) ||
    !subagentTypes.includes(agentType)
  ) {
    return {
      error: `Unknown or unavailable agent_type: ${agentType}. Available agent_type values: ${subagentTypes.join(", ")}`,
    };
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
