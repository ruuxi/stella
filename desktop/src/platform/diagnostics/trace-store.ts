/**
 * Global in-memory trace store for debugging agent execution.
 *
 * Captures tool calls, sub-agent lifecycle, and errors in a circular
 * buffer for dev-mode diagnostics.
 */

import { AGENT_IDS, type AgentIdLike } from "../../../../runtime/contracts/agent-runtime.js";
import { uiState } from "../ui-state";

/**
 * Explicit opt-in for trace diagnostics. Stella ships as a Vite dev server,
 * so `import.meta.env.DEV` is TRUE for real users and would leave these
 * listeners (and their memory growth) running in production. Gate on an
 * explicit flag instead so production stays off by default while developers
 * can still enable tracing via build env or a localStorage key.
 */
export function isTraceDiagnosticsEnabled(): boolean {
  if (import.meta.env.VITE_STELLA_TRACE === "1") return true;
  if (uiState.getItem("stella:trace") === "1") return true;
  try {
    // localStorage stays readable here so developers can still flip tracing
    // on from the console with `localStorage.setItem("stella:trace", "1")`.
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem("stella:trace") === "1"
    );
  } catch {
    // localStorage can throw in restricted contexts (e.g. some windows).
    return false;
  }
}

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
// Track the toolStartTimes keys opened under each runId. A run that finishes
// mid-tool (canceled/errored without a matching TOOL_END) never deletes its
// entries, so on RUN_FINISHED we sweep them via this index instead of leaking
// them for the renderer's lifetime. Mirrors the runIdToAgent RUN_FINISHED
// eviction below. Keys are the same `toolCallId ?? runId:toolName` used below,
// which don't all embed the runId — hence this explicit per-run index.
const runIdToToolKeys = new Map<string, Set<string>>();

// Track which runId belongs to which agent type. Bounded so a long-lived
// renderer that registers many runs cannot grow this map without limit
// (entries are evicted on run-finished, with an LRU cap as a backstop for
// runs that never emit a terminal event). Same semantics, no unbounded growth.
const MAX_RUN_AGENTS = 500;
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
  if (runId) {
    let keys = runIdToToolKeys.get(runId);
    if (!keys) {
      keys = new Set();
      runIdToToolKeys.set(runId, keys);
    }
    keys.add(key);
  }

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
  if (runId) {
    const keys = runIdToToolKeys.get(runId);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) runIdToToolKeys.delete(runId);
    }
  }

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
  // Re-insert to refresh LRU recency (Map preserves insertion order).
  runIdToAgent.delete(runId);
  runIdToAgent.set(runId, agentType);
  // Backstop eviction for runs that never emit a terminal event: drop the
  // oldest mapping once over the cap. Bounded growth, identical lookups.
  if (runIdToAgent.size > MAX_RUN_AGENTS) {
    const oldest = runIdToAgent.keys().next().value;
    if (oldest !== undefined) runIdToAgent.delete(oldest);
  }
}

/**
 * Evict a run's agent mapping once its run has finished. Called from the
 * trace IPC listener on RUN_FINISHED so completed runs don't accumulate.
 */
export function unregisterRunAgent(runId: string) {
  runIdToAgent.delete(runId);
}

/**
 * Sweep any tool-start timings still open for a finished run. Called from the
 * trace IPC listener on RUN_FINISHED alongside `unregisterRunAgent` so runs
 * that end mid-tool (canceled or errored without a matching TOOL_END) don't
 * leak entries in `toolStartTimes`.
 */
export function clearRunToolStarts(runId: string) {
  const keys = runIdToToolKeys.get(runId);
  if (!keys) return;
  for (const key of keys) {
    toolStartTimes.delete(key);
  }
  runIdToToolKeys.delete(runId);
}
