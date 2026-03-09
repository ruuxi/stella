/**
 * Global in-memory trace store for debugging agent execution.
 *
 * Captures tool calls, sub-agent lifecycle, errors, and voice events
 * in a circular buffer. Designed to be read by both the trace viewer UI
 * and copy-pasted into a conversation with Claude for debugging.
 */

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
  taskId?: string;
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
  extra?: Partial<Pick<TraceEntry, "agent" | "runId" | "taskId" | "toolName" | "toolCallId" | "data" | "duration">>,
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

  addTrace("tool", "tool-start", argsSummary ? `${toolName} ${argsSummary}` : `${toolName}`, {
    toolName,
    toolCallId,
    runId,
    agent,
    data: args && Object.keys(args).length > 0 ? { args } : undefined,
  });
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
  const preview = resultPreview ? resultPreview.slice(0, 200) : "";

  addTrace("tool", "tool-end", `${toolName} ${duration ? `(${duration}ms)` : ""}`, {
    toolName,
    toolCallId,
    runId,
    agent,
    duration,
    data: preview ? { resultPreview: preview } : undefined,
  });
}

export function traceAgentError(error: string, fatal: boolean, runId?: string) {
  const agent = runId ? runIdToAgent.get(runId) : undefined;
  addTrace("error", fatal ? "fatal-error" : "error", error.slice(0, 300), {
    runId,
    agent,
    data: { error, fatal },
  });
}

export function traceStreamEnd(runId?: string, finalTextPreview?: string) {
  const agent = runId ? runIdToAgent.get(runId) : undefined;
  addTrace(agent && agent !== "orchestrator" ? "agent" : "orchestrator", "stream-end", finalTextPreview?.slice(0, 150) ?? "(empty)", {
    runId,
    agent,
  });
}

export function traceTaskStarted(
  taskId: string,
  agentType: string,
  description: string,
  parentTaskId?: string,
) {
  addTrace("agent", "task-started", `[${agentType}] ${description}`, {
    taskId,
    agent: agentType,
    data: { description, parentTaskId },
  });
}

export function traceTaskCompleted(taskId: string, result?: string) {
  addTrace("agent", "task-completed", result?.slice(0, 200) ?? "(done)", {
    taskId,
  });
}

export function traceTaskFailed(taskId: string, error?: string) {
  addTrace("error", "task-failed", error?.slice(0, 300) ?? "(unknown error)", {
    taskId,
  });
}

export function traceTaskProgress(taskId: string, statusText: string) {
  addTrace("agent", "task-progress", statusText.slice(0, 200), {
    taskId,
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

export function registerRunAgent(runId: string, agentType: string) {
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
    const taskId = e.taskId ? ` taskId=${e.taskId}` : "";

    let line = `[${ts}] [${e.cat}]${agent} ${e.event}${tool}${callId}${taskId}${dur}`;
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
