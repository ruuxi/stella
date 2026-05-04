/**
 * Global in-memory trace store for debugging agent execution.
 *
 * Captures tool calls, sub-agent lifecycle, and errors in a circular
 * buffer for dev-mode diagnostics.
 */

import { AGENT_IDS, type AgentIdLike } from "../../../runtime/contracts/agent-runtime.js";

type TraceCategory =
  | "orchestrator"
  | "agent"
  | "tool"
  | "system"
  | "error";

type TraceEntry = {
  id: number;
  ts: number;
  cat: TraceCategory;
  event: string;
  agent?: string;
  runId?: string;
  agentId?: string;
  toolName?: string;
  toolCallId?: string;
  summary: string;
  data?: unknown;
  duration?: number;
};

const MAX_ENTRIES = 2000;

let entries: TraceEntry[] = [];
let nextId = 1;
const toolStartTimes = new Map<string, number>();

// Track which runId belongs to which agent type
const runIdToAgent = new Map<string, string>();

export function addTrace(
  cat: TraceCategory,
  event: string,
  summary: string,
  extra?: Partial<
    Pick<
      TraceEntry,
      | "agent"
      | "runId"
      | "agentId"
      | "toolName"
      | "toolCallId"
      | "data"
      | "duration"
    >
  >,
): TraceEntry {
  const entry: TraceEntry = {
    id: nextId++,
    ts: Date.now(),
    cat,
    event,
    summary,
    ...extra,
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }

  return entry;
}

// --- Helpers for recording common events ---

/** Coerce arbitrary runtime values (e.g. persisted tool errors) to a truncated string. */
export function formatTraceSnippet(value: unknown, maxLen: number): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return value.length > maxLen ? value.slice(0, maxLen) : value;
  }
  if (value instanceof Error) {
    return formatTraceSnippet(value.message, maxLen);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    const s = String(value);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > maxLen ? json.slice(0, maxLen) : json;
  } catch {
    const s = String(value);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }
}

const summarizeArgs = (args?: Record<string, unknown>): string => {
  if (!args || Object.keys(args).length === 0) return "";
  try {
    const json = JSON.stringify(args);
    return json.length > 120 ? `${json.slice(0, 117)}...` : json;
  } catch {
    return "[unserializable args]";
  }
};

export function traceToolStart(
  toolName: string,
  toolCallId: string | undefined,
  runId?: string,
  args?: Record<string, unknown>,
) {
  const key = toolCallId ?? `${runId}:${toolName}`;
  toolStartTimes.set(key, Date.now());

  const agent = runId ? runIdToAgent.get(runId) : undefined;
  const argsSummary = summarizeArgs(args);

  addTrace(
    "tool",
    "tool-start",
    argsSummary ? `${toolName} ${argsSummary}` : `${toolName}`,
    {
      toolName,
      toolCallId,
      runId,
      agent,
      data: args && Object.keys(args).length > 0 ? { args } : undefined,
    },
  );
}

export function traceToolEnd(
  toolName: string,
  toolCallId: string | undefined,
  resultPreview: string | undefined,
  runId?: string,
) {
  const key = toolCallId ?? `${runId}:${toolName}`;
  const startTime = toolStartTimes.get(key);
  const duration = startTime ? Date.now() - startTime : undefined;
  toolStartTimes.delete(key);

  const agent = runId ? runIdToAgent.get(runId) : undefined;
  const preview = resultPreview != null ? formatTraceSnippet(resultPreview, 200) : "";

  addTrace(
    "tool",
    "tool-end",
    `${toolName} ${duration ? `(${duration}ms)` : ""}`,
    {
      toolName,
      toolCallId,
      runId,
      agent,
      duration,
      data: preview ? { resultPreview: preview } : undefined,
    },
  );
}

export function traceAgentError(error: unknown, fatal: boolean, runId?: string) {
  const agent = runId ? runIdToAgent.get(runId) : undefined;
  addTrace("error", fatal ? "fatal-error" : "error", formatTraceSnippet(error, 300), {
    runId,
    agent,
    data: { error, fatal },
  });
}

export function traceStreamEnd(runId?: string, finalTextPreview?: unknown) {
  const agent = runId ? runIdToAgent.get(runId) : undefined;
  const preview = formatTraceSnippet(finalTextPreview, 150);
  addTrace(
    agent && agent !== AGENT_IDS.ORCHESTRATOR ? "agent" : "orchestrator",
    "stream-end",
    preview || "(empty)",
    {
      runId,
      agent,
    },
  );
}

export function traceTaskStarted(
  agentId: string,
  agentType: AgentIdLike,
  description: string,
  parentAgentId?: string,
) {
  addTrace("agent", "agent-started", `[${agentType}] ${description}`, {
    agentId,
    agent: agentType,
    data: { description, parentAgentId },
  });
}

export function traceTaskCompleted(agentId: string, result?: unknown) {
  addTrace("agent", "agent-completed", formatTraceSnippet(result, 200) || "(done)", {
    agentId,
  });
}

export function traceTaskFailed(agentId: string, error?: unknown) {
  addTrace(
    "error",
    "agent-failed",
    formatTraceSnippet(error, 300) || "(unknown error)",
    { agentId },
  );
}

export function traceTaskCanceled(agentId: string, error?: unknown) {
  addTrace(
    "agent",
    "agent-canceled",
    formatTraceSnippet(error, 300) || "(canceled)",
    { agentId },
  );
}

export function traceTaskProgress(agentId: string, statusText: string) {
  addTrace("agent", "agent-progress", statusText.slice(0, 200), {
    agentId,
  });
}

export function traceUserMessage(text: string, eventId?: string) {
  addTrace("system", "user-message", text.slice(0, 200), {
    data: eventId ? { eventId } : undefined,
  });
}

export function traceAssistantMessage(text: string, userMessageId?: string) {
  addTrace("orchestrator", "assistant-message", text.slice(0, 200), {
    data: userMessageId ? { userMessageId } : undefined,
  });
}

export function registerRunAgent(runId: string, agentType: AgentIdLike) {
  runIdToAgent.set(runId, agentType);
}
