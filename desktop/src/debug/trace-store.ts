/**
 * Global in-memory trace store for debugging agent execution.
 *
 * Captures tool calls, sub-agent lifecycle, errors, and voice events
 * in a circular buffer. Designed to be read by both the trace viewer UI
 * and copy-pasted into a conversation with Claude for debugging.
 */

import { AGENT_IDS, type AgentIdLike } from "@/shared/contracts/agent-runtime";

export type TraceCategory =
  | "orchestrator"
  | "agent"
  | "tool"
  | "voice"
  | "system"
  | "error";

export type TraceEntry = {
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

type Listener = () => void;

const MAX_ENTRIES = 2000;

let entries: TraceEntry[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const toolStartTimes = new Map<string, number>();

// Track which runId belongs to which agent type
const runIdToAgent = new Map<string, string>();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}

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

  notify();
  return entry;
}

export function getTraceEntries(): readonly TraceEntry[] {
  return entries;
}

export function clearTrace() {
  entries = [];
  toolStartTimes.clear();
  notify();
}

export function subscribeTrace(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

// --- Export for debugging ---

function formatTs(ts: number): string {
  const d = new Date(ts);
  return (
    d.toTimeString().slice(0, 8) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

export function formatTraceForClipboard(
  entriesToFormat?: readonly TraceEntry[],
): string {
  const items = entriesToFormat ?? entries;
  if (items.length === 0) return "(no trace entries)";

  const lines: string[] = [
    `Stella Trace — ${new Date().toISOString()} — ${items.length} entries`,
    "─".repeat(80),
  ];

  for (const e of items) {
    const ts = formatTs(e.ts);
    const agent = e.agent ? `[${e.agent}]` : "";
    const dur = e.duration != null ? ` (${e.duration}ms)` : "";
    const tool = e.toolName ? ` ${e.toolName}` : "";
    const callId = e.toolCallId ? ` callId=${e.toolCallId}` : "";
    const agentId = e.agentId ? ` agentId=${e.agentId}` : "";

    let line = `[${ts}] [${e.cat}]${agent} ${e.event}${tool}${callId}${agentId}${dur}`;
    if (e.summary) {
      line += ` | ${e.summary}`;
    }
    lines.push(line);

    if (e.data) {
      const dataStr =
        typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2);
      for (const dl of dataStr.split("\n")) {
        lines.push(`    ${dl}`);
      }
    }
  }

  return lines.join("\n");
}
