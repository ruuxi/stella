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
): StateContext => ({
  stateRoot,
  tasks: new Map(),
  agentApi,
  getSubagentTypes,
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
  const delivered = await ctx.agentApi.sendAgentMessage(threadId, message, sender);
  if (!delivered.delivered) {
    return { error: `Thread not found: ${threadId}` };
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

  if (ctx.agentApi) {
    logWorkingIndicatorTrace("[stella:working-indicator:spawn_agent]", {
      conversationId: context.conversationId,
      rawDescription,
      description,
      promptPreview: prompt.slice(0, 160),
      rootRunId: context.rootRunId,
    });
    const created = await ctx.agentApi.createAgent({
      conversationId: context.conversationId,
      description,
      prompt,
      agentType,
      rootRunId: context.rootRunId,
      agentDepth: nextAgentDepth,
      ...(typeof maxAgentDepth === "number" ? { maxAgentDepth } : {}),
      parentAgentId,
      storageMode,
    });
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
