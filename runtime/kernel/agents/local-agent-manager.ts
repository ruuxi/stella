/**
 * LocalAgentManager
 *
 * Two layers stacked on top of each other for every subagent thread, easy to
 * conflate:
 *
 *   1. Conversation layer — `subagentSession`, keyed by durable `threadId`,
 *      holds the long-lived `Agent` + message array. Lives across many
 *      runs and is only disposed when the task reaches a real terminal
 *      state (see end of `executeTask`) or `cancelAgent` is called.
 *
 *   2. Run-loop layer — `executeTask` / `runSubagent`. Each call to
 *      `runSubagent` is one user-turn → assistant-resolution cycle: a
 *      user message goes in, the assistant streams + uses tools until it
 *      decides to stop, then `runSubagent` returns.
 *
 * What this file historically called a "restart" only happens at layer 2.
 * Layer 1 is untouched: the session's message array is preserved across
 * the re-entry, so the LLM sees `[system, original user, prior turns,
 * follow-up user]` — i.e. the same conversation continuing with a new
 * user turn. The cached prefix doesn't change, prompt cache is preserved.
 *
 * The reason we have to exit and re-enter `executeTask` at all is that
 * `runSubagent` owns the agent loop for the duration of one user turn;
 * there is no way to splice an extra user message into the middle of an
 * in-flight assistant turn. So `send_input` aborts the current
 * `runSubagent` (ending the in-flight assistant turn early) and re-enters
 * with the follow-up as the next user message. The path funnels through
 * `deliverFollowUpAsNextTurn` → `tryStartNext` → `executeTask` →
 * `runSubagent`.
 */

import path from "path";
import { AGENT_PENDING_CLEANUP_EXPIRY_MS } from "./cleanup-policy.js";
import type {
  TaskToolActivity,
  TaskLifecycleStatus,
  TerminalTaskLifecycleStatus,
} from "../../contracts/agent-runtime.js";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "../../contracts/file-changes.js";
import type {
  ToolContext,
  ToolResult,
  ToolUpdateCallback,
  AgentToolApi,
  AgentToolRequest,
  AgentToolSnapshot,
} from "../tools/types.js";
import { sanitizeForLogs, truncate } from "../tools/utils.js";
import type { PersistedAgentRecord } from "../storage/runtime-store.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import type { RuntimeThreadRecord } from "../runtime-threads.js";
import type { ReasoningEffort } from "../preferences/local-preferences.js";
import type {
  AgentRuntimeEngine,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "../../contracts/agent-engine.js";
import type { RuntimeActiveRun } from "../../protocol/index.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import {
  type SubagentSession,
  getOrCreateSubagentSession,
} from "../agent-runtime/subagent-session.js";

export type LocalAgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  orchestratorReminderText?: string;
  staleUserReminderText?: string;
  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
  toolsAllowlist?: string[];
  model?: string;
  resolvedLlm?: ResolvedLlmRoute;
  reasoningEffort?: ReasoningEffort;
  agentDepth?: number;
  maxAgentDepth: number;
  coreMemory?: string;
  /** Dream's dynamic focus summary, push-injected as a resident startup doc. */
  memorySummary?: string;
  /** Durable user-profile facts (Remember tool), push-injected at session start. */
  userProfile?: string;
  personality?: string;
  threadHistory?: Array<{
    timestamp?: number;
    role: string;
    content: string;
    toolCallId?: string;
    payload?: PersistedRuntimeThreadPayload;
    customMessage?: RuntimeThreadMessage["customMessage"];
  }>;
  activeThreadId?: string;
  agentEngine?: AgentRuntimeEngine;
  /**
   * Per-spawn engine selection from spawn_agent's `model` parameter. When
   * set, `agentEngine` reflects the selected engine for this run and external
   * engines honor the pinned engine-native model (if any). For Claude Code
   * this also switches the run to vanilla pass-through mode (CC's own tools
   * and config, no Stella tool bridge or system-prompt override).
   */
  spawnEngine?: SpawnEngineSelection;
  /** Per-spawn reasoning override; never persisted to user preferences. */
  spawnReasoningEffort?: SpawnReasoningEffort;
  maxAgentConcurrency?: number;
};

export type LocalAgentStatus = "pending" | TaskLifecycleStatus;

type MessageEntry = {
  from: "orchestrator" | "subagent";
  text: string;
  timestamp: number;
};

type RuntimeAgentRecord = {
  /**
   * Durable thread id this agent execution is bound to. There is at most
   * one in-flight agent per thread, so this doubles as the agent identity.
   */
  threadId: string;
  conversationId: string;
  rootRunId?: string;
  description: string;
  prompt: string;
  agentType: string;
  /** Per-spawn model override (plain model-reference string). */
  model?: string;
  /** Per-spawn engine selection, including `default` for plain model pins. */
  spawnEngine?: SpawnEngineSelection;
  /** Per-spawn reasoning override; never persisted to user preferences. */
  spawnReasoningEffort?: SpawnReasoningEffort;
  toolWorkspaceRoot?: string;
  agentDepth: number;
  maxAgentDepth?: number;
  status: LocalAgentStatus;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * File records banked across runs whose terminal `agent-completed` was
   * never emitted. A `send_input` follow-up aborts the in-flight
   * `runSubagent` before its completion rollup fires, and without banking,
   * everything that run wrote (e.g. rendered videos in
   * `~/.stella/outputs/`) would never surface on any completion card.
   * Merged into `task.fileChanges` / `task.producedFiles` when a completion
   * finally lands, then drained at emission so a later re-run's completion
   * only reveals files produced since the last emitted rollup (preserving
   * the append-only reveal property the completion card relies on).
   */
  bankedFileChanges?: FileChangeRecord[];
  bankedProducedFiles?: ProducedFileRecord[];
  error?: string;
  controller: AbortController;
  storageMode: "cloud" | "local";
  cloudAgentId?: string;
  /** Resolves when the cloud task record has been created (or rejected). */
  cloudCreatePromise?: Promise<void>;
  parentAgentId?: string;
  /** Parked manager whose next turn begins when a managed report arrives. */
  waitingForManagedChildren?: boolean;
  /** A direct status/steering input should return an interim report upstream. */
  managerReportRequested?: boolean;
  /** Monotonic ownership token for mutable executeTask attempts. */
  attemptGeneration: number;
  /** Durable marker while abandoned resources remain unacknowledged. */
  pendingCleanup?: PersistedAgentRecord["pendingCleanup"];
  selfModMetadata?: AgentToolRequest["selfModMetadata"];
  recentActivity: string[];
  /**
   * Wall-clock timestamp of the last discrete liveness event: streamed
   * progress, a tool starting, or a tool finishing. It does NOT advance
   * while a tool call is running, so mid-call this stamp goes stale by
   * design — `activeToolCount` below is the authoritative in-flight signal.
   * Timeout/idle logic must never trust this timestamp alone; check the
   * count first (see the Schedule tool's idle test in tools/schedule.ts).
   */
  lastActivityAt: number;
  /**
   * Number of tool calls currently in flight (incremented on tool start,
   * decremented on tool end). The stamp above only moves on discrete events,
   * so a single tool call that runs longer than a poller's idle window would
   * still read as idle mid-call; a non-zero count tells pollers "working,
   * not idle" for the whole duration. Reset at turn boundaries so a run that
   * dies without emitting tool-end events can't leak a stuck non-zero count.
   */
  activeToolCount: number;
  progressBuffer: string;
  toSubagentQueue: string[];
  toOrchestratorQueue: string[];
  messageLog: MessageEntry[];
  /**
   * How many user turns this thread has had so far on the long-lived
   * subagent session. Zero on the first run (initial `spawn_agent`
   * prompt is still part of that first user message); incremented at
   * the top of every `executeTask` invocation. Used by
   * `buildTaskPrompt` to decide whether queued follow-ups should be
   * appended to the original prompt (first turn) or sent as a
   * standalone "Task update from orchestrator" user message
   * (subsequent turns).
   *
   * Not "retry count" — every increment is a legitimate user turn in
   * the same conversation. The session's message array is preserved
   * across the re-entry.
   */
  turnCount: number;
  /**
   * Set by `send_input` when the current `runSubagent` call has been
   * aborted so we can deliver the queued follow-up as the next user turn
   * on the same session. The post-run branch in `executeTask` checks
   * this to decide whether to fall through into
   * `deliverFollowUpAsNextTurn` (treat as continuation) vs. treating the
   * abort as a real cancellation.
   *
   * Not "restart" — the long-lived `subagentSession` is reused; only
   * the outer `executeTask` invocation re-enters.
   */
  interruptedForFollowUp: boolean;
  activeSelfModRunId?: string;
  terminalEventEmitted: boolean;
  pendingStartStatusText?: string;
  /**
   * Set on the re-activation paths (`send_input` follow-up delivery:
   * `sendAgentMessage` terminal/evicted resume, `deliverFollowUpAsNextTurn`)
   * so the NEXT `agent-started` emitted from `tryStartNext` is stamped as a
   * follow-up rather than a fresh spawn. Read-once and cleared alongside
   * `pendingStartStatusText`; a plain retry/reset leaves it unset so it
   * reads as a spawn.
   */
  pendingStartIsFollowUp?: boolean;
};

const formatTaskUpdateStatusText = (text: string): string =>
  truncate(text.replace(/\s+/g, " ").trim(), 200);

const fileRecordKey = (record: FileChangeRecord): string =>
  `${record.kind.type}:${record.path}:${
    record.kind.type === "update" ? (record.kind.move_path ?? "") : ""
  }`;

/**
 * Append-merge file records, deduped by `(kind, path, move_path)` — the same
 * identity the runner's per-run collectors use. First occurrence wins so a
 * banked record from an interrupted run keeps its original position when the
 * completing run re-reports the same write.
 */
const mergeUniqueFileRecords = <T extends FileChangeRecord>(
  existing: T[] | undefined,
  incoming: T[] | undefined,
): T[] | undefined => {
  if (!incoming?.length) return existing;
  if (!existing?.length) return [...incoming];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const record of [...existing, ...incoming]) {
    const key = fileRecordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
};

type FsLock = {
  id: string;
  threadId: string;
  key: string;
};

export type AgentLifecycleEvent = {
  type:
    | "agent-started"
    | "agent-completed"
    | "agent-failed"
    | "agent-canceled"
    | "agent-message"
    | "agent-progress";
  conversationId: string;
  /** Stable identity used to deduplicate durable manager-event routing. */
  eventId?: string;
  rootRunId?: string;
  userMessageId?: string;
  agentId: string;
  agentType: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  error?: string;
  statusText?: string;
  toolActivity?: TaskToolActivity;
  /**
   * `agent-started` only. `true` when this start re-activates an existing
   * thread (a `send_input` follow-up) rather than spawning fresh work — the
   * explicit signal the inline "background work" card uses to render the
   * follow-up variant. A fresh spawn leaves this unset. The follow-up's own
   * message still rides on `statusText` (the card title); this flag is only
   * the spawn-vs-follow-up discriminator.
   */
  isFollowUp?: boolean;
  /**
   * Delivery scope for the event. `orchestrator-only` skips every display
   * surface (persisted chat row / completion card, renderer stream event,
   * OS notification); `display-only` skips the hidden orchestrator
   * follow-up. Absent = both.
   *
   * No current emit site sets this: completions follow the state-based
   * rule (a real finish — the thread going idle with no pending follow-up
   * — always emits the full event immediately; internal turn boundaries
   * superseded by a pending follow-up emit nothing). The field is kept for
   * protocol compatibility and for future internal-boundary events that
   * should reach only the orchestrator.
   */
  audience?: "orchestrator-only" | "display-only";
  /**
   * Work group of the thread that emitted this event. Emit sites leave
   * these unset; the runner's central lifecycle handler enriches every
   * event from the thread registry so the Activity UI can collapse
   * sibling agents under one group header.
   */
  groupKey?: string;
  groupLabel?: string;
};

const ENV_ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const SECRET_FLAG_RE =
  /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const TOOL_ACTIVITY_HINT_CHARS = 320;

const redactEnvironmentValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactEnvironmentValues);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^(?:env|environment)$/i.test(key) &&
      entry &&
      typeof entry === "object"
    ) {
      output[key] = Object.fromEntries(
        Object.keys(entry as Record<string, unknown>).map((envKey) => [
          envKey,
          "[REDACTED]",
        ]),
      );
      continue;
    }
    output[key] = redactEnvironmentValues(entry);
  }
  return output;
};

export const sanitizeTaskToolArgsHint = (value: unknown): string => {
  let serialized = "";
  try {
    const json = JSON.stringify(
      redactEnvironmentValues(sanitizeForLogs(value)),
    );
    serialized = typeof json === "string" ? json : "";
  } catch {
    return "";
  }
  return truncate(
    serialized
      .replace(ENV_ASSIGNMENT_RE, "$1=[REDACTED]")
      .replace(SECRET_FLAG_RE, "$1 [REDACTED]"),
    TOOL_ACTIVITY_HINT_CHARS,
  );
};

const exitCodeFromToolEnd = (event: {
  details?: unknown;
  resultPreview?: string;
}): number | null | undefined => {
  const details =
    event.details && typeof event.details === "object"
      ? (event.details as Record<string, unknown>)
      : null;
  const value = details?.exitCode ?? details?.exit_code;
  return typeof value === "number" ? value : undefined;
};

const taskToolActivityFromStart = (event: {
  toolCallId: string;
  toolName: string;
  statusText?: string;
  args?: Record<string, unknown>;
}): TaskToolActivity => {
  const argsHint = sanitizeTaskToolArgsHint(event.args);
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    label: event.statusText ?? `Running ${event.toolName}`,
    ...(argsHint ? { argsHint } : {}),
    state: "started",
  };
};

const taskToolActivityFromEnd = (event: {
  toolCallId: string;
  toolName: string;
  details?: unknown;
  resultPreview?: string;
}): TaskToolActivity => {
  const exitCode = exitCodeFromToolEnd(event);
  const argsHint = sanitizeTaskToolArgsHint(event.details);
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    label:
      exitCode === undefined
        ? `Finished ${event.toolName}`
        : `${event.toolName} exited ${exitCode}`,
    ...(argsHint ? { argsHint } : {}),
    state: "completed",
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
};

type LocalAgentManagerOpts = {
  maxConcurrent?: number;
  /** Bounded ownership handoff for an aborted attempt that never settles. */
  attemptTeardownTimeoutMs?: number;
  /** Bounded force-release wait before a replacement attempt takes ownership. */
  attemptResourceCleanupTimeoutMs?: number;
  /** Initial background retry delay for timed-out attempt cleanup. */
  attemptResourceCleanupRetryMs?: number;
  getMaxConcurrent?: () => number;
  resolveTaskThread?: (args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
    nameHint?: string;
  }) => {
    threadId: string;
    reused: boolean;
    groupKey?: string;
    groupLabel?: string;
  } | null;
  /** Member thread ids of a `grp-…` work group, for group-level cancel. */
  listGroupMemberThreadIds?: (groupKey: string) => string[];
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
  fetchAgentContext: (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
    model?: string;
    spawnEngine?: SpawnEngineSelection;
    spawnReasoningEffort?: SpawnReasoningEffort;
    toolWorkspaceRoot?: string;
    selfModMetadata?: AgentToolRequest["selfModMetadata"];
  }) => Promise<LocalAgentContext>;
  runSubagent: (args: {
    conversationId: string;
    userMessageId: string;
    agentType: string;
    agentId?: string;
    rootRunId?: string;
    toolWorkspaceRoot?: string;
    taskDescription: string;
    taskPrompt: string;
    agentContext: LocalAgentContext;
    persistToConvex: boolean;
    enableRemoteTools: boolean;
    abortSignal: AbortSignal;
    selfModMetadata?: AgentToolRequest["selfModMetadata"];
    selfModRunId?: string;
    /**
     * Explicit feature identity for any self-mod commits this run makes.
     * Workflow steps pass their workflow's identity so every step of one
     * workflow commits to ONE feature instead of fragmenting into
     * per-step features keyed by ephemeral agent ids.
     */
    selfModFeature?: { featureId: string; featureTitle: string };
    /** Dynamic ownership check used to fence manager children from self-mod. */
    isManagerOwned?: () => boolean;
    onSelfModRunStarted?: (runId: string) => void;
    onSelfModRunClosed?: (runId: string) => void;
    onAttemptCleanupReady?: (cleanup: {
      selfModRunId?: string;
      forceRelease: () => Promise<{
        released: boolean;
        heldResources?: string[];
      }>;
    }) => void;
    shouldContinueSelfModLifecycleAfterInterrupt?: () => boolean;
    /**
     * Long-lived session bound to the durable subagent threadId. The
     * runner forwards this to `runSubagentTask` so the underlying Pi
     * `Agent` survives across restart-on-input cycles. Disposed by the
     * manager when the task reaches a terminal status.
     */
    subagentSession?: SubagentSession;
    onProgress?: (chunk: string) => void;
    onToolStart?: (event: {
      runId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      statusText?: string;
    }) => void;
    onToolEnd?: (event: {
      runId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      resultPreview: string;
      html?: string;
    }) => void;
    toolExecutor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
      onUpdate?: ToolUpdateCallback,
    ) => Promise<ToolResult>;
  }) => Promise<{
    runId: string;
    result: string;
    interrupted?: boolean;
    error?: string;
    fileChanges?: FileChangeRecord[];
    producedFiles?: ProducedFileRecord[];
  }>;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  createCloudAgentRecord: (args: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType: string;
    parentAgentId?: string;
    maxAgentDepth?: number;
  }) => Promise<{ agentId: string }>;
  completeCloudAgentRecord: (args: {
    agentId: string;
    status: TerminalTaskLifecycleStatus;
    result?: string;
    error?: string;
  }) => Promise<void>;
  getCloudAgentRecord: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancelCloudAgentRecord: (
    agentId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
  saveAgentRecord?: (record: PersistedAgentRecord) => void;
  getAgentRecord?: (threadId: string) => PersistedAgentRecord | null;
  listAgentRecordsByStatus?: (
    status: TaskLifecycleStatus,
  ) => PersistedAgentRecord[];
  listAgentRecordsWithPendingCleanup?: () => PersistedAgentRecord[];
  listActiveThreads?: (conversationId: string) => RuntimeThreadRecord[];
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeFsPathKey = (candidate: string, cwd?: string): string => {
  const resolved = path.resolve(cwd ?? process.cwd(), candidate);
  const normalized = path.normalize(resolved);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const pathsOverlap = (a: string, b: string): boolean => {
  if (a === "*" || b === "*") return true;
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
};

const BASH_PATH_PATTERN = String.raw`(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])`;

const extractBashPath = (command: string): string | undefined => {
  const match = command.match(
    new RegExp(
      String.raw`(?:^|\s)(?:"(${BASH_PATH_PATTERN}[^"]+)"|'(${BASH_PATH_PATTERN}[^']+)'|(${BASH_PATH_PATTERN}[^\s"'` +
        "`" +
        String.raw`]+))`,
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const READ_ONLY_EXEC_TOOLS = new Set([
  "read_file",
  "search",
  "glob",
  "web_fetch",
  "web_search",
  "heartbeat_get",
  "cron_list",
  "describe",
]);

const EXEC_MUTATION_PATTERNS: RegExp[] = [
  /\btools\s*\.\s*write_file\s*\(/,
  /\btools\s*\.\s*apply_patch\s*\(/,
  /\btools\s*\.\s*shell\s*\(/,
  /\btools\s*\.\s*display\s*\(/,
  /\btools\s*\.\s*memory\s*\(/,
  /\btools\s*\.\s*spawn_agent\s*\(/,
  /\btools\s*\.\s*spawn_manager\s*\(/,
  /\btools\s*\.\s*send_input\s*\(/,
  /\btools\s*\.\s*pause_agent\s*\(/,
  /\btools\s*\.\s*cron_(?:add|update|remove|run)\s*\(/,
  /\btools\s*\.\s*heartbeat_(?:upsert|run)\s*\(/,
  /\btools\s*\.\s*schedule\s*\(/,
  /\bfs(?:\.promises)?\.(?:writeFile|appendFile|cp|copyFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|truncate|chmod|chown|utimes)\s*\(/,
  /\bchild_process\s*\.\s*(?:exec|execFile|spawn|fork)\s*\(/,
  /\bprocess\s*\.\s*chdir\s*\(/,
];

const isClearlyReadOnlyExecProgram = (source: string): boolean => {
  for (const pattern of EXEC_MUTATION_PATTERNS) {
    if (pattern.test(source)) {
      return false;
    }
  }

  const toolCalls = source.matchAll(/\btools\s*\.\s*(\w+)\s*\(/g);
  for (const match of toolCalls) {
    const method = match[1];
    if (!method || !READ_ONLY_EXEC_TOOLS.has(method)) {
      return false;
    }
  }

  return true;
};

const getFsLockKey = (
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): string | null => {
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = normalizeString(
      args.file_path ?? args.path ?? args.target_path,
    );
    if (!filePath) return "*";
    return normalizeFsPathKey(
      filePath,
      normalizeString(
        args.working_directory ?? args.cwd ?? context?.stellaAppDir,
      ),
    );
  }
  if (toolName === "Bash") {
    const command = normalizeString(args.command);
    if (!command) return "*";
    const pathFromCommand = extractBashPath(command);
    if (!pathFromCommand) return "*";
    return normalizeFsPathKey(
      pathFromCommand,
      normalizeString(
        args.working_directory ?? args.cwd ?? context?.stellaAppDir,
      ),
    );
  }
  if (toolName === "Exec") {
    const source = normalizeString(args.source ?? args.code);
    if (!source) return "*";
    return isClearlyReadOnlyExecProgram(source) ? null : "*";
  }
  return null;
};

const isSpawnAgentTool = (toolName: string): boolean =>
  toolName === "spawn_agent" || toolName === "spawn_manager";

const AGENT_INPUT_INTERRUPT_ERROR = "Interrupted by agent input";

export const AGENT_SHUTDOWN_CANCEL_REASON =
  "Canceled because Stella closed or restarted.";
export const AGENT_ORPHANED_RESTART_CANCEL_REASON =
  "Canceled because Stella restarted before the agent finished.";
// Sentinel set by the orchestrator's pause_agent tool so the runner
// can suppress the hidden `[Task canceled]` follow-up turn that would
// otherwise replace the user-facing reply with an empty silence.
export const AGENT_PAUSE_CANCEL_REASON = "Paused by orchestrator.";
export const DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS = 5_000;
export const DEFAULT_AGENT_ATTEMPT_RESOURCE_CLEANUP_TIMEOUT_MS = 2_000;
export const DEFAULT_AGENT_ATTEMPT_RESOURCE_CLEANUP_RETRY_MS = 1_000;

type InFlightAttempt = {
  generation: number;
  promise: Promise<void>;
  /** Set before the first awaited self-mod acquire; cleared with the attempt. */
  selfModRunId?: string;
  forceRelease?: () => Promise<{
    released: boolean;
    heldResources?: string[];
  }>;
  cleanupFlight?: Promise<{
    released: boolean;
    heldResources?: string[];
  }>;
  takeoverStarted?: boolean;
};

const logWorkingIndicatorTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};

export class LocalAgentManager implements AgentToolApi {
  private readonly defaultMaxConcurrent: number;
  private readonly opts: LocalAgentManagerOpts;
  private readonly tasks = new Map<string, RuntimeAgentRecord>();
  private readonly pendingQueue: string[] = [];
  private runningCount = 0;
  private readonly inFlightAttempts = new Map<string, InFlightAttempt>();
  private readonly attemptTakeoverTimers = new Map<
    string,
    {
      generation: number;
      promise: Promise<void>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly attemptCleanupRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly cancelCascadeInProgress = new Set<string>();
  private readonly activeFsLocks: FsLock[] = [];
  private readonly fsLockWaiters: Array<() => void> = [];
  /**
   * Long-lived per-task subagent sessions keyed by durable threadId (E2).
   * Created lazily on first `executeTask` for a thread, reused across
   * restart-on-input attempts within the same thread, disposed when the
   * task reaches a terminal status. Paused tasks keep their session.
   */
  private readonly subagentSessions = new Map<string, SubagentSession>();
  private static readonly MAX_QUEUE_MESSAGES = 32;
  private static readonly MAX_LOG_MESSAGES = 80;
  private nextId = 0;

  constructor(opts: LocalAgentManagerOpts) {
    this.opts = opts;
    this.defaultMaxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
    this.cancelOrphanedPersistedAgents();
    this.reportPersistedPendingCleanups();
  }

  private reportPersistedPendingCleanups(): void {
    for (const record of this.opts.listAgentRecordsWithPendingCleanup?.() ??
      []) {
      if (!record.pendingCleanup) continue;
      console.error(
        `[agents] Unresolved resource cleanup survived worker restart for ${record.threadId} attempt ${record.pendingCleanup.attemptGeneration}: ${record.pendingCleanup.diagnostic} The process-local release handle is gone; runtime force-resume reconciliation is required.`,
      );
    }
  }

  private cancelOrphanedPersistedAgents(): void {
    const now = Date.now();
    const runningRecords =
      this.opts.listAgentRecordsByStatus?.("running") ?? [];
    for (const record of runningRecords) {
      const error = AGENT_ORPHANED_RESTART_CANCEL_REASON;
      this.opts.saveAgentRecord?.({
        ...record,
        status: "canceled",
        completedAt: now,
        error,
        updatedAt: now,
      });
      // The runtime worker, not Electron's renderer/main process, owns agent
      // execution. Persist the matching lifecycle transition here so every
      // Activity consumer observes the real worker restart. Renderer code
      // must not guess that an old `agent-started` event stopped merely
      // because the desktop window restarted: the detached worker may still
      // be running it.
      this.opts.onAgentEvent?.({
        type: "agent-canceled",
        conversationId: record.conversationId,
        agentId: record.threadId,
        agentType: record.agentType,
        description: record.description,
        parentAgentId: record.parentAgentId,
        error,
        audience: "display-only",
      });
    }
  }

  private consumeTaskMessages(
    task: RuntimeAgentRecord,
    recipient: "orchestrator" | "subagent",
  ): string[] {
    const queue =
      recipient === "subagent"
        ? task.toSubagentQueue
        : task.toOrchestratorQueue;
    if (queue.length === 0) return [];
    const out = [...queue];
    queue.length = 0;
    return out;
  }

  private buildTaskPrompt(task: RuntimeAgentRecord): string {
    const updates = this.consumeTaskMessages(task, "subagent");
    if (updates.length === 0) {
      return task.prompt;
    }

    const updateBlock = updates
      .map((text, index) => `${index + 1}. ${text}`)
      .join("\n");
    if (task.turnCount === 0) {
      return [
        task.prompt,
        "Task updates from orchestrator:",
        updateBlock,
        "Apply the orchestrator's message according to its intent. If it asks a question, requests status, or asks for a report, answer that request and then stop; do not continue the underlying task. If it gives new or changed work instructions, apply them and continue the task. Newer updates override conflicting earlier instructions.",
      ].join("\n\n");
    }

    return [
      "Task update from orchestrator:",
      updateBlock,
      "Your previous turn was paused so you can apply this update now. Follow the orchestrator's message according to its intent: if it asks a question, requests status, or asks for a report, answer that request and then stop; do not continue the underlying task. If it gives new or changed work instructions, apply them and continue the task. Newer updates override conflicting earlier instructions.",
    ].join("\n\n");
  }

  private shouldDeliverFollowUp(task: RuntimeAgentRecord): boolean {
    return task.interruptedForFollowUp && task.status !== "canceled";
  }

  private persistTask(task: RuntimeAgentRecord): void {
    this.opts.saveAgentRecord?.({
      threadId: task.threadId,
      conversationId: task.conversationId,
      agentType: task.agentType,
      description: task.description,
      agentDepth: task.agentDepth,
      ...(typeof task.maxAgentDepth === "number"
        ? { maxAgentDepth: task.maxAgentDepth }
        : {}),
      ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
      ...(task.selfModMetadata
        ? { selfModMetadata: task.selfModMetadata }
        : {}),
      status: task.status === "pending" ? "running" : task.status,
      attemptGeneration: task.attemptGeneration,
      ...(task.pendingCleanup ? { pendingCleanup: task.pendingCleanup } : {}),
      ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      ...(typeof task.result === "string" ? { result: task.result } : {}),
      ...(typeof task.error === "string" ? { error: task.error } : {}),
      updatedAt: Date.now(),
    });
  }

  private buildTaskSnapshot(task: RuntimeAgentRecord): AgentToolSnapshot {
    return {
      id: task.threadId,
      description: task.description,
      status: task.status === "pending" ? "running" : task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      result: task.result,
      error: task.error,
      recentActivity:
        task.status === "running" || task.status === "pending"
          ? task.recentActivity
          : undefined,
      lastActivityAt: task.lastActivityAt,
      activeToolCount:
        task.status === "running" || task.status === "pending"
          ? task.activeToolCount
          : 0,
      messages: task.messageLog.slice(-10),
    };
  }

  private buildPersistedSnapshot(
    record: PersistedAgentRecord,
  ): AgentToolSnapshot {
    return {
      id: record.threadId,
      description: record.description,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private isDescendantOf(threadId: string, ancestorThreadId: string): boolean {
    const visited = new Set<string>();
    let cursor = this.getAgentState(threadId)?.parentAgentId;
    while (cursor) {
      if (cursor === ancestorThreadId) return true;
      if (visited.has(cursor)) return false;
      visited.add(cursor);
      cursor = this.getAgentState(cursor)?.parentAgentId;
    }
    return false;
  }

  /** True while at least one adopted/spawned descendant has work in flight. */
  private hasActiveManagedChildren(managerThreadId: string): boolean {
    for (const task of this.tasks.values()) {
      if (
        task.threadId !== managerThreadId &&
        this.isDescendantOf(task.threadId, managerThreadId) &&
        (task.status === "pending" || task.status === "running")
      ) {
        return true;
      }
    }
    return (this.opts.listAgentRecordsByStatus?.("running") ?? []).some(
      (record) =>
        record.threadId !== managerThreadId &&
        this.isDescendantOf(record.threadId, managerThreadId),
    );
  }

  isManagerThread(threadId: string): boolean {
    return (
      this.tasks.get(threadId)?.agentType === AGENT_IDS.MANAGER ||
      this.opts.getAgentRecord?.(threadId)?.agentType === AGENT_IDS.MANAGER
    );
  }

  private getAgentState(
    threadId: string,
  ): RuntimeAgentRecord | PersistedAgentRecord | null {
    return (
      this.tasks.get(threadId) ?? this.opts.getAgentRecord?.(threadId) ?? null
    );
  }

  private isExplicitlyPaused(
    task: RuntimeAgentRecord | PersistedAgentRecord | null,
  ): boolean {
    return (
      task?.status === "canceled" && task.error === AGENT_PAUSE_CANCEL_REASON
    );
  }

  private isActiveAgentState(
    task: RuntimeAgentRecord | PersistedAgentRecord | null,
  ): boolean {
    return task?.status === "pending" || task?.status === "running";
  }

  private lifecycleEventId(
    task: RuntimeAgentRecord,
    type:
      | "agent-message"
      | "agent-completed"
      | "agent-failed"
      | "agent-canceled",
  ): string {
    return `${task.threadId}:${task.attemptGeneration}:${type}`;
  }

  private assertActiveParentChain(request: AgentToolRequest): void {
    if (!request.parentAgentId) return;
    const visited = new Set<string>();
    let cursor: string | undefined = request.parentAgentId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error("Cannot create a child under a cyclic parent chain.");
      }
      visited.add(cursor);
      const parent = this.getAgentState(cursor);
      if (!parent) {
        throw new Error(`Parent thread not found: ${cursor}`);
      }
      if (parent.conversationId !== request.conversationId) {
        throw new Error("Cannot create a child in another conversation.");
      }
      if (!this.isActiveAgentState(parent)) {
        throw new Error(
          `Cannot create a child because parent thread ${cursor} is paused or finished.`,
        );
      }
      cursor = parent.parentAgentId;
    }
  }

  private wouldCreateParentCycle(
    threadId: string,
    parentAgentId: string,
  ): boolean {
    const visited = new Set<string>();
    let cursor: string | undefined = parentAgentId;
    while (cursor) {
      if (cursor === threadId) return true;
      if (visited.has(cursor)) return true;
      visited.add(cursor);
      cursor = this.getAgentState(cursor)?.parentAgentId;
    }
    return false;
  }

  async adoptAgent(
    threadId: string,
    parentAgentId: string,
  ): Promise<{ adopted: boolean; reason?: string }> {
    if (threadId === parentAgentId) {
      return { adopted: false, reason: "A manager cannot adopt itself." };
    }
    const manager = this.getAgentState(parentAgentId);
    if (!manager || manager.agentType !== AGENT_IDS.MANAGER) {
      return { adopted: false, reason: `Manager not found: ${parentAgentId}` };
    }
    if (manager.status !== "pending" && manager.status !== "running") {
      return {
        adopted: false,
        reason: "A paused or finished manager cannot adopt threads.",
      };
    }
    const target = this.getAgentState(threadId);
    if (!target) {
      return { adopted: false, reason: `Thread not found: ${threadId}` };
    }
    if (target.agentType === AGENT_IDS.MANAGER) {
      return {
        adopted: false,
        reason: "Managers cannot adopt other managers.",
      };
    }
    if (
      this.tasks.get(threadId)?.activeSelfModRunId ||
      this.inFlightAttempts.get(threadId)?.selfModRunId
    ) {
      return {
        adopted: false,
        reason:
          "A thread with an active Stella self-mod run cannot be adopted by a manager; wait for the run to close or pause it first.",
      };
    }
    if (target.conversationId !== manager.conversationId) {
      return {
        adopted: false,
        reason: "A manager cannot adopt a thread from another conversation.",
      };
    }
    if (this.wouldCreateParentCycle(threadId, parentAgentId)) {
      return {
        adopted: false,
        reason: "Adoption would create a parent cycle.",
      };
    }

    const existingParentId = target.parentAgentId;
    if (existingParentId === parentAgentId) {
      return { adopted: true };
    }
    if (existingParentId) {
      const existingParent = this.getAgentState(existingParentId);
      if (
        !this.isExplicitlyPaused(existingParent) ||
        !this.isExplicitlyPaused(target)
      ) {
        return {
          adopted: false,
          reason: `Thread is already owned by manager ${existingParentId}; pause that manager before transferring ownership.`,
        };
      }
    } else if (
      target.status === "completed" ||
      target.status === "error" ||
      target.status === "canceled"
    ) {
      return {
        adopted: false,
        reason:
          "A terminal thread cannot be adopted after its completion was routed.",
      };
    }

    const task = this.tasks.get(threadId);
    if (task) {
      task.parentAgentId = parentAgentId;
      this.persistTask(task);
      return { adopted: true };
    }
    this.opts.saveAgentRecord?.({
      ...(target as PersistedAgentRecord),
      parentAgentId,
      updatedAt: Date.now(),
    });
    return { adopted: true };
  }

  private resetTaskForNextAttempt(
    task: RuntimeAgentRecord,
    prompt: string,
    options?: { preserveSelfModRun?: boolean },
  ): void {
    // Invalidate any older executeTask still unwinding after an abort. It may
    // finish later, but it no longer owns this thread's mutable state.
    task.attemptGeneration += 1;
    task.prompt = prompt;
    task.status = "pending";
    task.startedAt = Date.now();
    task.completedAt = null;
    task.result = undefined;
    task.error = undefined;
    task.progressBuffer = "";
    task.recentActivity = [`Continuing thread: ${truncate(prompt, 200)}`];
    task.lastActivityAt = Date.now();
    task.activeToolCount = 0;
    task.toSubagentQueue.length = 0;
    task.toOrchestratorQueue.length = 0;
    task.controller = new AbortController();
    task.interruptedForFollowUp = false;
    task.terminalEventEmitted = false;
    task.pendingStartStatusText = undefined;
    // Cleared here so a bare reset reads as a spawn; the follow-up callers
    // (`sendAgentMessage` / `deliverFollowUpAsNextTurn`) re-set it right after.
    task.pendingStartIsFollowUp = undefined;
    task.waitingForManagedChildren = false;
    if (!options?.preserveSelfModRun) {
      // A terminal pause/cancel closes the prior run in the runner's finally
      // path. The resumed ownership epoch must begin a new run rather than
      // inheriting an id whose cancel/finalize already consumed its state.
      task.activeSelfModRunId = undefined;
    }
  }

  private hydrateTaskFromRecord(
    record: PersistedAgentRecord,
    prompt: string,
    statusText = prompt,
  ): RuntimeAgentRecord {
    return {
      threadId: record.threadId,
      conversationId: record.conversationId,
      description: record.description,
      prompt,
      agentType: record.agentType,
      agentDepth: record.agentDepth,
      maxAgentDepth: record.maxAgentDepth,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller: new AbortController(),
      storageMode: "local",
      parentAgentId: record.parentAgentId,
      selfModMetadata: record.selfModMetadata,
      activeSelfModRunId: undefined,
      recentActivity: [`Continuing thread: ${truncate(prompt, 200)}`],
      lastActivityAt: Date.now(),
      activeToolCount: 0,
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
      pendingStartStatusText: formatTaskUpdateStatusText(statusText),
      // Resuming an evicted/persisted thread is always a `send_input`
      // follow-up (this helper is only reached from that path).
      pendingStartIsFollowUp: true,
      waitingForManagedChildren: false,
      managerReportRequested: false,
      attemptGeneration: Number.isFinite(record.attemptGeneration)
        ? Math.max(0, Math.floor(record.attemptGeneration))
        : 0,
      pendingCleanup: record.pendingCleanup,
    };
  }

  private enqueueTask(task: RuntimeAgentRecord, prioritize = false): void {
    this.tasks.set(task.threadId, task);
    if (prioritize) {
      this.pendingQueue.unshift(task.threadId);
    } else {
      this.pendingQueue.push(task.threadId);
    }
    this.persistTask(task);
    this.tryStartNext();
  }

  /**
   * Re-enter the run-loop layer with the queued follow-up as the next
   * user turn on the existing long-lived `subagentSession`. Despite
   * being implemented as "reset + re-enqueue", this is NOT a fresh run
   * of the task — the session's accumulated message array (system +
   * original user prompt + prior assistant/tool turns) is preserved,
   * and the synthesized "Task update from orchestrator: …" string is
   * just the next user message that gets appended on top.
   *
   * Reached when `send_input` aborted the in-flight `runSubagent` and
   * we want to deliver the follow-up immediately (`shouldDeliverFollowUp`
   * true).
   */
  private deliverFollowUpAsNextTurn(task: RuntimeAgentRecord): void {
    const pendingStartStatusText = task.pendingStartStatusText;
    const prompt = this.buildTaskPrompt(task);
    this.resetTaskForNextAttempt(task, prompt, { preserveSelfModRun: true });
    // The superseded turn's boundary emitted no completion event (the
    // dispatch short-circuits into this delivery before the lifecycle
    // emit) — an interjection extends ongoing work, so only the continued
    // turn's eventual real finish surfaces a completion card.
    task.pendingStartStatusText = pendingStartStatusText;
    // Interjected in-flight work is a `send_input` follow-up, not a spawn.
    task.pendingStartIsFollowUp = true;
    task.recentActivity = [
      pendingStartStatusText ?? "Applying task update from orchestrator.",
    ];
    this.pendingQueue.unshift(task.threadId);
    this.persistTask(task);
  }

  private clearAttemptTakeoverTimer(
    threadId: string,
    generation?: number,
    promise?: Promise<void>,
  ): void {
    const pending = this.attemptTakeoverTimers.get(threadId);
    if (!pending) return;
    if (generation !== undefined && pending.generation !== generation) return;
    if (promise !== undefined && pending.promise !== promise) return;
    clearTimeout(pending.timer);
    this.attemptTakeoverTimers.delete(threadId);
  }

  private scheduleAttemptTakeover(
    task: RuntimeAgentRecord,
    activeAttempt: InFlightAttempt,
  ): void {
    const existing = this.attemptTakeoverTimers.get(task.threadId);
    if (
      existing?.generation === activeAttempt.generation &&
      existing.promise === activeAttempt.promise
    ) {
      return;
    }
    this.clearAttemptTakeoverTimer(task.threadId);
    const timeoutMs = Math.max(
      1,
      this.opts.attemptTeardownTimeoutMs ??
        DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS,
    );
    const timer = setTimeout(() => {
      const inFlight = this.inFlightAttempts.get(task.threadId);
      const takeover = this.attemptTakeoverTimers.get(task.threadId);
      if (
        inFlight?.generation !== activeAttempt.generation ||
        inFlight.promise !== activeAttempt.promise ||
        takeover?.generation !== activeAttempt.generation ||
        takeover.promise !== activeAttempt.promise ||
        task.status !== "pending" ||
        task.attemptGeneration === activeAttempt.generation
      ) {
        this.clearAttemptTakeoverTimer(
          task.threadId,
          activeAttempt.generation,
          activeAttempt.promise,
        );
        return;
      }

      this.attemptTakeoverTimers.delete(task.threadId);
      if (inFlight.takeoverStarted) return;
      inFlight.takeoverStarted = true;
      void this.forceReleaseAndTakeOver(task, inFlight);
    }, timeoutMs);
    timer.unref?.();
    this.attemptTakeoverTimers.set(task.threadId, {
      generation: activeAttempt.generation,
      promise: activeAttempt.promise,
      timer,
    });
  }

  private async forceReleaseAndTakeOver(
    task: RuntimeAgentRecord,
    activeAttempt: InFlightAttempt,
  ): Promise<void> {
    const cleanup = await this.runBoundedAttemptCleanup(activeAttempt);
    if (!cleanup.released) {
      this.recordAttemptCleanupDiagnostic(task, activeAttempt, cleanup.reason);
      this.scheduleAttemptCleanupRetry(task, activeAttempt, 0);
    } else {
      this.clearAttemptCleanupDiagnostic(task);
    }

    const inFlight = this.inFlightAttempts.get(task.threadId);
    if (
      inFlight !== activeAttempt ||
      inFlight.generation !== activeAttempt.generation ||
      inFlight.promise !== activeAttempt.promise ||
      task.status !== "pending" ||
      task.attemptGeneration === activeAttempt.generation
    ) {
      return;
    }

    // Cleanup either completed or is now durably diagnosed and retried in
    // the background. Generation/controller checks fence every later state
    // write from the abandoned promise while the replacement proceeds.
    this.inFlightAttempts.delete(task.threadId);
    this.runningCount = Math.max(0, this.runningCount - 1);
    this.tryStartNext();
  }

  private async runBoundedAttemptCleanup(
    activeAttempt: InFlightAttempt,
  ): Promise<{
    released: boolean;
    reason?: string;
  }> {
    if (!activeAttempt.forceRelease) return { released: true };
    let cleanupFlight = activeAttempt.cleanupFlight;
    if (!cleanupFlight) {
      cleanupFlight = Promise.resolve().then(() =>
        activeAttempt.forceRelease!(),
      );
      activeAttempt.cleanupFlight = cleanupFlight;
      void cleanupFlight.then(
        () => {
          if (activeAttempt.cleanupFlight === cleanupFlight) {
            activeAttempt.cleanupFlight = undefined;
          }
        },
        () => {
          if (activeAttempt.cleanupFlight === cleanupFlight) {
            activeAttempt.cleanupFlight = undefined;
          }
        },
      );
    }
    const cleanupTimeoutMs = Math.max(
      1,
      this.opts.attemptResourceCleanupTimeoutMs ??
        DEFAULT_AGENT_ATTEMPT_RESOURCE_CLEANUP_TIMEOUT_MS,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        cleanupFlight.then(
          (result) =>
            result.released
              ? { released: true }
              : {
                  released: false,
                  reason: `cleanup acknowledged held resources: ${(result.heldResources ?? ["unknown"]).join(", ")}`,
                },
          (error) => ({
            released: false,
            reason: `cleanup failed: ${(error as Error).message}`,
          }),
        ),
        new Promise<{ released: false; reason: string }>((resolve) => {
          timeout = setTimeout(
            () =>
              resolve({
                released: false,
                reason: `cleanup timed out after ${cleanupTimeoutMs}ms`,
              }),
            cleanupTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private recordAttemptCleanupDiagnostic(
    task: RuntimeAgentRecord,
    activeAttempt: InFlightAttempt,
    reason = "cleanup did not acknowledge release",
  ): void {
    const diagnostic = `Superseded attempt ${activeAttempt.generation} still has resources pending release: ${reason}. Background cleanup retries are active.`;
    console.error(`[agents] ${task.threadId}: ${diagnostic}`);
    task.pendingCleanup = {
      attemptGeneration: activeAttempt.generation,
      diagnostic,
      recordedAt: Date.now(),
      expiresAt: Date.now() + AGENT_PENDING_CLEANUP_EXPIRY_MS,
    };
    task.error = diagnostic;
    task.recentActivity = [truncate(diagnostic, 500)];
    this.persistTask(task);
  }

  private clearAttemptCleanupDiagnostic(task: RuntimeAgentRecord): void {
    const diagnostic = task.pendingCleanup?.diagnostic;
    if (!diagnostic) return;
    task.pendingCleanup = undefined;
    if (task.error === diagnostic) task.error = undefined;
    this.persistTask(task);
  }

  private scheduleAttemptCleanupRetry(
    task: RuntimeAgentRecord,
    activeAttempt: InFlightAttempt,
    retryCount: number,
  ): void {
    if (!activeAttempt.forceRelease) return;
    const key = `${task.threadId}:${activeAttempt.generation}`;
    if (this.attemptCleanupRetryTimers.has(key)) return;
    const initialDelayMs = Math.max(
      1,
      this.opts.attemptResourceCleanupRetryMs ??
        DEFAULT_AGENT_ATTEMPT_RESOURCE_CLEANUP_RETRY_MS,
    );
    const delayMs = Math.min(
      initialDelayMs * 2 ** Math.min(retryCount, 5),
      30_000,
    );
    const timer = setTimeout(() => {
      this.attemptCleanupRetryTimers.delete(key);
      void this.runBoundedAttemptCleanup(activeAttempt).then((cleanup) => {
        if (cleanup.released) {
          this.clearAttemptCleanupDiagnostic(task);
          return;
        }
        this.recordAttemptCleanupDiagnostic(
          task,
          activeAttempt,
          cleanup.reason,
        );
        this.scheduleAttemptCleanupRetry(task, activeAttempt, retryCount + 1);
      });
    }, delayMs);
    timer.unref?.();
    this.attemptCleanupRetryTimers.set(key, timer);
  }

  private tryStartNext(): void {
    const maxConcurrent = Math.max(
      1,
      optsValueOrDefault(
        this.opts.getMaxConcurrent?.(),
        this.defaultMaxConcurrent,
      ),
    );
    // Schedule stale-attempt takeover independently of free global slots.
    // With max concurrency 1, the hung predecessor itself occupies the only
    // slot; waiting until the start loop runs would therefore deadlock before
    // the teardown deadline was ever armed.
    for (const threadId of this.pendingQueue) {
      const task = this.tasks.get(threadId);
      const activeAttempt = this.inFlightAttempts.get(threadId);
      if (task?.status === "pending" && activeAttempt) {
        this.scheduleAttemptTakeover(task, activeAttempt);
      }
    }
    let remainingCandidates = this.pendingQueue.length;
    while (
      this.runningCount < maxConcurrent &&
      this.pendingQueue.length > 0 &&
      remainingCandidates > 0
    ) {
      const threadId = this.pendingQueue.shift();
      if (!threadId) break;
      remainingCandidates -= 1;
      const task = this.tasks.get(threadId);
      if (!task || task.status !== "pending") {
        continue;
      }
      const activeAttempt = this.inFlightAttempts.get(threadId);
      if (activeAttempt) {
        // A canceled/interrupted attempt still owns teardown for this thread.
        // Keep the resume queued, but bound that ownership: an abort-ignoring
        // promise is fenced and replaced after the teardown lease expires.
        this.pendingQueue.push(threadId);
        this.scheduleAttemptTakeover(task, activeAttempt);
        continue;
      }
      this.runningCount += 1;
      task.status = "running";
      const generation = ++task.attemptGeneration;
      const controller = task.controller;
      const startStatusText = task.pendingStartStatusText ?? task.description;
      const startIsFollowUp = task.pendingStartIsFollowUp ?? false;
      task.pendingStartStatusText = undefined;
      task.pendingStartIsFollowUp = undefined;
      this.persistTask(task);
      this.opts.onAgentEvent?.({
        type: "agent-started",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        ...(startStatusText ? { statusText: startStatusText } : {}),
        ...(startIsFollowUp ? { isFollowUp: true } : {}),
      });
      logWorkingIndicatorTrace("[stella:working-indicator:agent-started]", {
        threadId: task.threadId,
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        description: task.description,
        statusText: startStatusText,
      });
      const execution = this.executeTask(task, {
        generation,
        controller,
      }).catch(() => undefined);
      this.inFlightAttempts.set(threadId, { generation, promise: execution });
      void execution.finally(() => {
        const activeAttempt = this.inFlightAttempts.get(threadId);
        if (
          activeAttempt?.generation === generation &&
          activeAttempt.promise === execution
        ) {
          this.clearAttemptTakeoverTimer(threadId, generation, execution);
          this.inFlightAttempts.delete(threadId);
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.tryStartNext();
        }
      });
    }
  }

  private acquireFsLock(threadId: string, key: string): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = () => {
        const conflicting = this.activeFsLocks.some(
          (lock) => lock.threadId !== threadId && pathsOverlap(lock.key, key),
        );
        if (conflicting) {
          this.fsLockWaiters.push(attempt);
          return;
        }
        const lock: FsLock = {
          id: `${threadId}:${++this.nextId}`,
          threadId,
          key,
        };
        this.activeFsLocks.push(lock);
        resolve(() => {
          const index = this.activeFsLocks.findIndex(
            (entry) => entry.id === lock.id,
          );
          if (index >= 0) {
            this.activeFsLocks.splice(index, 1);
          }
          const waiters = this.fsLockWaiters.splice(
            0,
            this.fsLockWaiters.length,
          );
          for (const waiter of waiters) {
            queueMicrotask(waiter);
          }
        });
      };
      attempt();
    });
  }

  private async executeTask(
    task: RuntimeAgentRecord,
    attempt: { generation: number; controller: AbortController },
  ): Promise<void> {
    const isCurrentAttempt = () =>
      task.attemptGeneration === attempt.generation &&
      task.controller === attempt.controller;
    try {
      const runId = `run:${task.threadId}:${++this.nextId}`;
      // Create the session before the context load. A managed-child report
      // can persist while that async load (or prompt hooks) is in flight;
      // the session then retains `notifyHistoryChanged()` even before its Pi
      // Agent exists and reloads SQLite immediately after creation.
      const subagentSession = getOrCreateSubagentSession(
        this.subagentSessions,
        task.threadId,
        task.conversationId,
        task.agentType,
      );
      const context = await this.opts.fetchAgentContext({
        conversationId: task.conversationId,
        agentType: task.agentType,
        runId,
        threadId: task.threadId,
        ...(task.model ? { model: task.model } : {}),
        ...(task.spawnEngine ? { spawnEngine: task.spawnEngine } : {}),
        ...(task.spawnReasoningEffort
          ? { spawnReasoningEffort: task.spawnReasoningEffort }
          : {}),
        ...(task.toolWorkspaceRoot
          ? { toolWorkspaceRoot: task.toolWorkspaceRoot }
          : {}),
        selfModMetadata: task.selfModMetadata,
      });
      if (!isCurrentAttempt()) return;

      context.maxAgentDepth =
        typeof task.maxAgentDepth === "number"
          ? Math.min(context.maxAgentDepth, task.maxAgentDepth)
          : context.maxAgentDepth;
      context.agentDepth = task.agentDepth;

      const taskPrompt = this.buildTaskPrompt(task);
      task.turnCount += 1;

      const runSubagentArgs: Parameters<
        LocalAgentManagerOpts["runSubagent"]
      >[0] = {
        conversationId: task.conversationId,
        userMessageId: runId,
        agentType: task.agentType,
        agentId: task.threadId,
        rootRunId: task.rootRunId,
        ...(task.toolWorkspaceRoot
          ? { toolWorkspaceRoot: task.toolWorkspaceRoot }
          : {}),
        taskDescription: task.description,
        taskPrompt,
        agentContext: context,
        subagentSession,
        persistToConvex: task.storageMode === "cloud",
        enableRemoteTools: true,
        abortSignal: attempt.controller.signal,
        selfModMetadata: task.selfModMetadata,
        isManagerOwned: () =>
          Boolean(
            task.parentAgentId && this.isManagerThread(task.parentAgentId),
          ),
        ...(task.activeSelfModRunId
          ? { selfModRunId: task.activeSelfModRunId }
          : {}),
        onSelfModRunStarted: (runId) => {
          if (!isCurrentAttempt()) return;
          task.activeSelfModRunId = runId;
        },
        onSelfModRunClosed: (runId) => {
          if (!isCurrentAttempt()) return;
          if (task.activeSelfModRunId === runId) {
            task.activeSelfModRunId = undefined;
          }
        },
        onAttemptCleanupReady: (cleanup) => {
          const activeAttempt = this.inFlightAttempts.get(task.threadId);
          if (activeAttempt?.generation === attempt.generation) {
            if (cleanup.selfModRunId) {
              // Mark ownership before the first awaited HMR/lifecycle acquire.
              // Adoption must reject throughout partially-acquired startup,
              // not only after beginRun has fully acknowledged.
              activeAttempt.selfModRunId = cleanup.selfModRunId;
            }
            activeAttempt.forceRelease = cleanup.forceRelease;
            return;
          }
          // Registration can race a zero/very-short takeover deadline. If
          // ownership has already moved on, close this abandoned attempt's
          // resources immediately; its own finally may never run.
          void cleanup.forceRelease().catch((error) => {
            console.warn(
              "[agents] failed to release late-registered attempt resources:",
              (error as Error).message,
            );
          });
        },
        shouldContinueSelfModLifecycleAfterInterrupt: () =>
          isCurrentAttempt() && this.shouldDeliverFollowUp(task),
        onProgress: (chunk) => {
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          )
            return;
          if (typeof chunk !== "string" || !chunk) return;
          task.progressBuffer += chunk;
          if (task.progressBuffer.length > 4_000) {
            task.progressBuffer = task.progressBuffer.slice(
              task.progressBuffer.length - 4_000,
            );
          }
          const compact = task.progressBuffer.replace(/\s+/g, " ").trim();
          if (!compact) return;
          task.recentActivity = [truncate(compact, 500)];
          task.lastActivityAt = Date.now();
        },
        onToolStart: (ev) => {
          // Once cancelAgent has marked this task canceled, suppress any
          // in-flight `tool_execution_start` events from the agent loop —
          // those would otherwise leak `agent-progress` lifecycle events
          // after `agent-canceled`, leaving a phantom "Working … Task" chip
          // in the footer that re-adds the task to the live UI state.
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          ) {
            return;
          }
          const statusText = ev.statusText ?? `Running ${ev.toolName}`;
          const toolActivity = taskToolActivityFromStart({
            ...ev,
            statusText,
          });
          // Tool lifecycle is a liveness signal too: without this, a single
          // long tool call looks idle to snapshot pollers even though the
          // agent is working.
          task.recentActivity = [truncate(statusText, 500)];
          task.lastActivityAt = Date.now();
          task.activeToolCount += 1;
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText,
            toolActivity,
          });
          logWorkingIndicatorTrace(
            "[stella:working-indicator:agent-progress]",
            {
              threadId: task.threadId,
              conversationId: task.conversationId,
              rootRunId: task.rootRunId,
              description: task.description,
              statusText,
            },
          );
        },
        onToolEnd: (ev) => {
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          ) {
            return;
          }
          task.lastActivityAt = Date.now();
          task.activeToolCount = Math.max(0, task.activeToolCount - 1);
          const toolActivity = taskToolActivityFromEnd(ev);
          task.recentActivity = [truncate(toolActivity.label, 500)];
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText: toolActivity.label,
            toolActivity,
          });
        },
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
          const canFinishInterruptedTool = () =>
            this.shouldDeliverFollowUp(task);
          if (
            !isCurrentAttempt() ||
            (attempt.controller.signal.aborted && !canFinishInterruptedTool())
          ) {
            return { error: "Agent attempt was superseded." };
          }
          if (
            task.storageMode === "cloud" &&
            isSpawnAgentTool(toolName) &&
            task.cloudCreatePromise
          ) {
            await task.cloudCreatePromise.catch(() => undefined);
          }
          const scopedContext: ToolContext = {
            ...toolContext,
            agentId: task.threadId,
            ...(task.cloudAgentId ? { cloudAgentId: task.cloudAgentId } : {}),
            agentDepth: task.agentDepth,
            maxAgentDepth: context.maxAgentDepth,
          };
          const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
          if (!lockKey) {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          }
          const release = await this.acquireFsLock(task.threadId, lockKey);
          try {
            if (
              !isCurrentAttempt() ||
              (attempt.controller.signal.aborted && !canFinishInterruptedTool())
            ) {
              return { error: "Agent attempt was superseded." };
            }
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          } finally {
            release();
          }
        },
      };
      let result: Awaited<ReturnType<LocalAgentManagerOpts["runSubagent"]>>;
      // Turn boundary: whatever the run reports, no tool is in flight once
      // `runSubagent` returns (or throws). Clearing here — not just in
      // onToolEnd — keeps the in-flight signal honest for runs that die
      // mid-tool without ever emitting a tool-end event.
      try {
        result = await this.opts.runSubagent(runSubagentArgs);
      } finally {
        if (isCurrentAttempt()) {
          task.activeToolCount = 0;
        }
      }

      if (!isCurrentAttempt()) return;

      task.completedAt = Date.now();
      // Bank this run's collected file records immediately, before any
      // branch below decides the run's fate. A `send_input` follow-up
      // aborts the run without emitting its completion; banking is what
      // lets those files survive into the eventual rollup.
      task.bankedFileChanges = mergeUniqueFileRecords(
        task.bankedFileChanges,
        result.fileChanges,
      );
      task.bankedProducedFiles = mergeUniqueFileRecords(
        task.bankedProducedFiles,
        result.producedFiles,
      );
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` aborted the current `runSubagent` on purpose so
        // we can deliver the queued follow-up as the next user turn on
        // the same session. The dispatch at the end of this method calls
        // `deliverFollowUpAsNextTurn`; status stays in its current state
        // so the dispatch can read `interruptedForFollowUp`.
      } else if (
        attempt.controller.signal.aborted ||
        task.status === "canceled"
      ) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else if (result.interrupted) {
        task.status = "canceled";
        task.error = "Canceled";
      } else if (result.error) {
        task.status = "error";
        task.error = result.error;
      } else {
        task.status = "completed";
        task.result = result.result;
        // Completion rollup = banked records from send_input-interrupted
        // runs + this run's (already merged into the bank above). Drained
        // when the `agent-completed` event is actually emitted, so files
        // are never re-revealed across rollups but survive completions
        // that get skipped (e.g. a queued follow-up re-entering the loop).
        task.fileChanges = task.bankedFileChanges;
        task.producedFiles = task.bankedProducedFiles;
      }
    } catch (error) {
      if (!isCurrentAttempt()) return;
      task.completedAt = Date.now();
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` aborted the current `runSubagent` on purpose; see
        // comment above.
      } else if (attempt.controller.signal.aborted) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else {
        task.status = "error";
        task.error = (error as Error).message ?? "Task failed";
      }
    }

    if (!isCurrentAttempt()) return;

    if (
      this.shouldDeliverFollowUp(task) ||
      (task.toSubagentQueue.length > 0 && task.status === "completed")
    ) {
      this.deliverFollowUpAsNextTurn(task);
      return;
    }

    if (
      task.agentType === AGENT_IDS.MANAGER &&
      task.status === "completed" &&
      this.hasActiveManagedChildren(task.threadId)
    ) {
      const shouldReportInterim =
        task.managerReportRequested === true ||
        task.result?.trimStart().startsWith("[Milestone]") === true;
      if (shouldReportInterim) {
        this.opts.onAgentEvent?.({
          type: "agent-message",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-message"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          result: task.result,
        });
      }
      // A manager turn ending while children remain is a wait boundary, not
      // completion. Keep its long-lived session and wake it when the next
      // child report (or direct send_input) arrives.
      task.status = "pending";
      task.completedAt = null;
      task.result = undefined;
      task.error = undefined;
      task.controller = new AbortController();
      task.waitingForManagedChildren = true;
      task.managerReportRequested = false;
      task.terminalEventEmitted = false;
      this.persistTask(task);
      return;
    }

    // Task has reached a terminal status (completed/error/canceled). Drop
    // the long-lived SubagentSession so its Agent + message array can be
    // reclaimed; future tasks for this threadId would build a fresh
    // session if the runtime ever re-enqueues this thread (rare — terminal
    // is sticky). Done before persistTask + lifecycle emit so any
    // listener-triggered work (e.g. cloud sync) doesn't see stale state.
    const session = this.subagentSessions.get(task.threadId);
    if (session) {
      this.subagentSessions.delete(task.threadId);
      try {
        session.dispose();
      } catch {
        // Best-effort: dispose just aborts the agent and frees the ref.
      }
    }

    this.persistTask(task);

    // Emit task lifecycle event
    if (!task.terminalEventEmitted) {
      if (task.status === "completed") {
        const completedEvent: AgentLifecycleEvent = {
          type: "agent-completed",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-completed"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          result: task.result,
          ...(task.fileChanges?.length
            ? { fileChanges: task.fileChanges }
            : {}),
          ...(task.producedFiles?.length
            ? { producedFiles: task.producedFiles }
            : {}),
        };
        // The rollup is now captured on the event — drain the bank so a
        // send_input re-run's later completion only reveals new files.
        task.bankedFileChanges = undefined;
        task.bankedProducedFiles = undefined;
        // State-based completion rule: reaching this emit means the thread
        // is going idle with no pending follow-up (a pending follow-up
        // short-circuited into `deliverFollowUpAsNextTurn` above, before
        // this block) — that IS the real finish, so the full event emits
        // immediately. No deferral: if the orchestrator resumes the thread
        // afterwards, that's a new run with its own completion card —
        // Done → running-again is honest history, not a glitch.
        //
        // Busy-vs-idle classification is atomic with turn state: there is
        // no `await` between `runSubagent` resolving and this emit, so a
        // `send_input` either ran before dispatch (task still "running" →
        // queued as a follow-up → the short-circuit above wins and no
        // completion emits for this boundary) or runs after it (task
        // terminal → the terminal-resume path in `sendAgentMessage`, with
        // this completion already emitted). A completion can never be
        // misclassified as interjected.
        this.opts.onAgentEvent?.(completedEvent);
      } else if (task.status === "error") {
        this.opts.onAgentEvent?.({
          type: "agent-failed",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-failed"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          error: task.error,
        });
      } else if (task.status === "canceled") {
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-canceled"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          error: task.error,
        });
      }
      task.terminalEventEmitted = true;
    }

    // Sync task completion to Convex in background (non-blocking)
    if (task.storageMode === "cloud") {
      void (async () => {
        // Wait for cloud task creation to finish so we have the cloudAgentId
        if (task.cloudCreatePromise) {
          await task.cloudCreatePromise.catch(() => {});
        }
        if (!task.cloudAgentId) return;
        const status =
          task.status === "completed"
            ? "completed"
            : task.status === "canceled"
              ? "canceled"
              : "error";
        await this.opts
          .completeCloudAgentRecord({
            agentId: task.cloudAgentId,
            status,
            result: task.result ? truncate(task.result, 30_000) : undefined,
            error: task.error ? truncate(task.error, 10_000) : undefined,
          })
          .catch(() => {
            // Background sync failure — task is still tracked locally
          });
      })();
    }
  }

  async createAgent(request: AgentToolRequest): Promise<{
    threadId: string;
    activeThreads?: RuntimeThreadRecord[];
  }> {
    this.assertActiveParentChain(request);
    const controller = new AbortController();
    const resolvedThread =
      this.opts.resolveTaskThread?.({
        conversationId: request.conversationId,
        agentType: request.agentType,
        threadId: request.threadId,
        nameHint: request.description,
      }) ?? null;
    const threadId =
      resolvedThread?.threadId ?? request.threadId ?? `thread-${++this.nextId}`;

    const task: RuntimeAgentRecord = {
      threadId,
      conversationId: request.conversationId,
      rootRunId: request.rootRunId,
      description: request.description,
      prompt: request.prompt,
      agentType: request.agentType,
      ...(request.model ? { model: request.model } : {}),
      ...(request.spawnEngine ? { spawnEngine: request.spawnEngine } : {}),
      ...(request.spawnReasoningEffort
        ? { spawnReasoningEffort: request.spawnReasoningEffort }
        : {}),
      ...(request.toolWorkspaceRoot
        ? { toolWorkspaceRoot: request.toolWorkspaceRoot }
        : {}),
      agentDepth: Math.max(1, request.agentDepth ?? 1),
      maxAgentDepth:
        typeof request.maxAgentDepth === "number"
          ? Math.max(1, Math.floor(request.maxAgentDepth))
          : undefined,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller,
      storageMode: request.storageMode,
      parentAgentId: request.parentAgentId,
      selfModMetadata: request.selfModMetadata,
      activeSelfModRunId: undefined,
      recentActivity: [],
      lastActivityAt: Date.now(),
      activeToolCount: 0,
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
      waitingForManagedChildren: false,
      managerReportRequested: false,
      attemptGeneration: 0,
    };
    logWorkingIndicatorTrace("[stella:working-indicator:create-agent]", {
      threadId,
      conversationId: request.conversationId,
      rootRunId: request.rootRunId,
      description: request.description,
      agentType: request.agentType,
      parentAgentId: request.parentAgentId,
    });

    // Create cloud record in background (non-blocking)
    // Store the promise so completion can await it before syncing status.
    if (request.storageMode === "cloud") {
      const cloudParentTaskId =
        request.parentAgentId && !this.tasks.has(request.parentAgentId)
          ? request.parentAgentId
          : undefined;
      task.cloudCreatePromise = this.opts
        .createCloudAgentRecord({
          conversationId: request.conversationId,
          description: request.description,
          prompt: request.prompt,
          agentType: request.agentType,
          parentAgentId: cloudParentTaskId,
          maxAgentDepth: task.maxAgentDepth,
        })
        .then((created) => {
          task.cloudAgentId = created.agentId;
        })
        .catch(() => {
          // Cloud record creation failed — task runs locally only
        });
    }

    // Re-check immediately before publication. Today the setup above is
    // synchronous, but keeping the invariant at the commit point closes the
    // spawn-during-pause race if thread/cloud setup later gains an await.
    this.assertActiveParentChain(request);
    this.enqueueTask(task);
    return {
      threadId: task.threadId,
      activeThreads: this.opts.listActiveThreads?.(request.conversationId),
    };
  }

  /**
   * Run a single agent turn OUTSIDE the durable task surface: no thread
   * row, no work slot, no lifecycle events, no persisted agent record.
   * This is the execution primitive for workflow scripts — their agents
   * report to the script, not to the orchestrator. The agentId should
   * use the `<conversationId>::subagent::<type>::…` shape so any
   * incidental thread-storage writes derive the right conversation.
   */
  async runEphemeralAgent(args: {
    conversationId: string;
    agentId: string;
    description: string;
    prompt: string;
    rootRunId?: string;
    selfModFeature?: { featureId: string; featureTitle: string };
    signal: AbortSignal;
  }): Promise<{ result: string; error?: string; interrupted?: boolean }> {
    const agentType = "general";
    const agentContext = await this.opts.fetchAgentContext({
      conversationId: args.conversationId,
      agentType,
      runId: args.agentId,
      threadId: args.agentId,
    });
    const session = getOrCreateSubagentSession(
      this.subagentSessions,
      args.agentId,
      args.conversationId,
      agentType,
    );
    try {
      const outcome = await this.opts.runSubagent({
        conversationId: args.conversationId,
        userMessageId: args.agentId,
        agentType,
        agentId: args.agentId,
        ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
        ...(args.selfModFeature ? { selfModFeature: args.selfModFeature } : {}),
        taskDescription: args.description,
        taskPrompt: args.prompt,
        agentContext,
        subagentSession: session,
        persistToConvex: false,
        enableRemoteTools: true,
        abortSignal: args.signal,
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
          const scopedContext: ToolContext = {
            ...toolContext,
            agentId: args.agentId,
            agentDepth: 1,
            maxAgentDepth: agentContext.maxAgentDepth,
          };
          const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
          if (!lockKey) {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          }
          const release = await this.acquireFsLock(args.agentId, lockKey);
          try {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          } finally {
            release();
          }
        },
      });
      return {
        result: outcome.result,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.interrupted ? { interrupted: true } : {}),
      };
    } finally {
      const liveSession = this.subagentSessions.get(args.agentId);
      if (liveSession) {
        this.subagentSessions.delete(args.agentId);
        try {
          liveSession.dispose();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /**
   * Cancel every member thread of a work group. Member discovery comes
   * from the durable thread registry (not the in-memory task map) so
   * already-persisted members are covered too; cancelAgent is a no-op
   * for members that already reached a terminal status.
   */
  private listActiveManagedDescendantThreadIds(
    managerThreadId: string,
  ): string[] {
    const threadIds = new Set<string>();
    for (const task of this.tasks.values()) {
      if (
        task.threadId !== managerThreadId &&
        this.isDescendantOf(task.threadId, managerThreadId) &&
        (task.status === "pending" || task.status === "running")
      ) {
        threadIds.add(task.threadId);
      }
    }
    for (const record of this.opts.listAgentRecordsByStatus?.("running") ??
      []) {
      if (
        record.threadId !== managerThreadId &&
        this.isDescendantOf(record.threadId, managerThreadId)
      ) {
        threadIds.add(record.threadId);
      }
    }
    return [...threadIds];
  }

  private async cascadeCancelManagedChildren(
    managerThreadId: string,
    reason?: string,
  ): Promise<void> {
    // Old persisted data may contain manager cycles from before adoption was
    // guarded. Keep pause durable without recursively walking such a cycle.
    if (this.cancelCascadeInProgress.has(managerThreadId)) return;
    this.cancelCascadeInProgress.add(managerThreadId);
    try {
      for (const childThreadId of this.listActiveManagedDescendantThreadIds(
        managerThreadId,
      )) {
        await this.cancelAgent(childThreadId, reason);
      }
    } finally {
      this.cancelCascadeInProgress.delete(managerThreadId);
    }
  }

  async cancelGroup(
    groupKey: string,
    reason?: string,
  ): Promise<{ canceled: boolean; canceledThreadIds: string[] }> {
    const memberIds = this.opts.listGroupMemberThreadIds?.(groupKey) ?? [];
    if (memberIds.length === 0) {
      return { canceled: false, canceledThreadIds: [] };
    }
    const canceledThreadIds: string[] = [];
    for (const threadId of memberIds) {
      const result = await this.cancelAgent(threadId, reason);
      if (result.canceled) {
        canceledThreadIds.push(threadId);
      }
    }
    return { canceled: canceledThreadIds.length > 0, canceledThreadIds };
  }

  async getAgent(agentId: string): Promise<AgentToolSnapshot | null> {
    const local = this.tasks.get(agentId);
    if (local) {
      return this.buildTaskSnapshot(local);
    }
    const persisted = this.opts.getAgentRecord?.(agentId);
    if (persisted) {
      return this.buildPersistedSnapshot(persisted);
    }
    return await this.opts.getCloudAgentRecord(agentId);
  }

  getActiveAgentCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled"
      ) {
        continue;
      }
      count++;
    }
    return count;
  }

  listActiveAgentRuns(): RuntimeActiveRun[] {
    const byRunId = new Map<string, RuntimeActiveRun>();
    for (const task of this.tasks.values()) {
      if (
        task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled"
      ) {
        continue;
      }
      const runId = task.rootRunId ?? task.threadId;
      if (!runId) continue;
      byRunId.set(runId, {
        runId,
        conversationId: task.conversationId,
      });
    }
    return [...byRunId.values()];
  }

  shutdown(reason = AGENT_SHUTDOWN_CANCEL_REASON): void {
    for (const pending of this.attemptTakeoverTimers.values()) {
      clearTimeout(pending.timer);
    }
    this.attemptTakeoverTimers.clear();
    for (const timer of this.attemptCleanupRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.attemptCleanupRetryTimers.clear();
    for (const task of this.tasks.values()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }
      void this.cancelAgent(task.threadId, reason);
    }
  }

  async cancelAgent(
    agentId: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> {
    const local = this.tasks.get(agentId);
    if (local) {
      if (
        local.status === "completed" ||
        local.status === "error" ||
        local.status === "canceled"
      ) {
        if (local.agentType === AGENT_IDS.MANAGER) {
          await this.cascadeCancelManagedChildren(agentId, reason);
        }
        return { canceled: true };
      }
      const previousStatus = local.status;
      local.error = reason ?? "Canceled";
      local.status = "canceled";
      local.completedAt = Date.now();
      local.interruptedForFollowUp = false;
      local.pendingStartStatusText = undefined;
      local.pendingStartIsFollowUp = undefined;
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: local.conversationId,
        rootRunId: local.rootRunId,
        agentId: local.threadId,
        agentType: local.agentType,
        description: local.description,
        parentAgentId: local.parentAgentId,
        statusText: "Pausing",
      });
      local.controller.abort(new Error(local.error));
      // Dispose the long-lived `SubagentSession` eagerly here too.
      // `executeTask` disposes at the end of the run, which is the
      // happy path for normal cancellation (abort propagates into
      // `runTurn`, the interrupted finalize fires, executeTask
      // reaches its dispose block). But if the abort gets swallowed
      // mid-flight (e.g. a tool executor doesn't honor the signal,
      // or executeTask isn't running yet because the task was still
      // pending), the session's Pi `Agent` would stay allocated
      // forever — the canceled task never re-enters `executeTask`.
      // `PiSessionCore.dispose` is idempotent and guarded against
      // already-null state, so calling it from both paths is safe;
      // the second call is a no-op.
      const session = this.subagentSessions.get(agentId);
      if (session) {
        this.subagentSessions.delete(agentId);
        try {
          session.dispose();
        } catch {
          // Best-effort.
        }
      }
      if (
        !local.terminalEventEmitted &&
        (previousStatus === "pending" || previousStatus === "running")
      ) {
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: local.conversationId,
          eventId: this.lifecycleEventId(local, "agent-canceled"),
          rootRunId: local.rootRunId,
          agentId: local.threadId,
          agentType: local.agentType,
          description: local.description,
          parentAgentId: local.parentAgentId,
          error: local.error,
        });
        local.terminalEventEmitted = true;
      }
      this.persistTask(local);
      if (local.agentType === AGENT_IDS.MANAGER) {
        await this.cascadeCancelManagedChildren(agentId, local.error);
      }
      if (local.storageMode === "cloud" && local.cloudAgentId) {
        await this.opts.cancelCloudAgentRecord(local.cloudAgentId, local.error);
      }
      return { canceled: true };
    }
    const persisted = this.opts.getAgentRecord?.(agentId);
    if (persisted) {
      if (persisted.status === "running") {
        this.opts.saveAgentRecord?.({
          ...persisted,
          status: "canceled",
          completedAt: Date.now(),
          error: reason ?? "Canceled",
          updatedAt: Date.now(),
        });
      }
      if (persisted.agentType === AGENT_IDS.MANAGER) {
        await this.cascadeCancelManagedChildren(agentId, reason ?? "Canceled");
      }
      return { canceled: true };
    }
    return await this.opts.cancelCloudAgentRecord(agentId, reason);
  }

  async sendAgentMessage(
    agentId: string,
    message: string,
    from: "orchestrator" | "subagent",
    options?: {
      description?: string;
      rootRunId?: string;
      parentAgentId?: string;
      deliveryKind?: "manager-event" | "external-input";
    },
  ): Promise<{ delivered: boolean; reason?: string }> {
    const text = message.trim();
    if (!text) return { delivered: false };
    const updateStatusSource = options?.description?.trim()
      ? options.description
      : text;
    const updateStatusText = formatTaskUpdateStatusText(updateStatusSource);
    const rootRunId = options?.rootRunId?.trim() || undefined;
    // An orchestrator follow-up re-tasks the thread, so the thread adopts
    // the follow-up's description. Everything keyed per-thread (the folded
    // Activity row, snapshots, the persisted record) then reflects the
    // latest instruction instead of the original spawn text — per-occurrence
    // surfaces (the inline chat cards) keep their own titles via statusText.
    const followUpDescription =
      from === "orchestrator"
        ? options?.description?.trim() || undefined
        : undefined;
    const isManagerEvent = options?.deliveryKind === "manager-event";
    const deliveredInput = isManagerEvent
      ? "Review the newly persisted managed-child event in this thread and continue the instructed process."
      : text;
    const task = this.tasks.get(agentId);
    if (!task) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      const persisted = this.opts.getAgentRecord?.(agentId);
      if (!persisted) {
        return { delivered: false };
      }
      if (persisted.agentType === "workflow") {
        // Workflow runs are script-driven, not conversational — hydrating
        // one as a General task would re-run its description as a prompt.
        return {
          delivered: false,
          reason: `${agentId} is a workflow and cannot take send_input. Start a new workflow (or spawn_agent) for follow-up work.`,
        };
      }
      if (
        isManagerEvent &&
        persisted.agentType === AGENT_IDS.MANAGER &&
        (persisted.status === "completed" ||
          persisted.status === "error" ||
          persisted.status === "canceled")
      ) {
        // The orchestration layer already persisted this child report into
        // the manager thread. Internal events may wake a waiting manager, but
        // they must never resurrect one the user paused or that already
        // finished. A later external send_input rehydrates the durable report.
        return { delivered: true };
      }
      // Re-activate the durable thread row (and its whole group) so the
      // resumed work re-enters the active slot budget and reappears under
      // "Other Threads" — without this, an evicted thread keeps running
      // with status 'evicted' and stays invisible to the orchestrator.
      this.opts.resolveTaskThread?.({
        conversationId: persisted.conversationId,
        agentType: persisted.agentType,
        threadId: persisted.threadId,
      });
      const resumedTask = this.hydrateTaskFromRecord(
        persisted,
        text,
        updateStatusText,
      );
      if (rootRunId) {
        resumedTask.rootRunId = rootRunId;
      }
      if (options?.parentAgentId) {
        resumedTask.parentAgentId = options.parentAgentId;
      }
      if (
        resumedTask.agentType === AGENT_IDS.MANAGER &&
        options?.deliveryKind === "external-input"
      ) {
        resumedTask.managerReportRequested = true;
      }
      if (followUpDescription) {
        resumedTask.description = followUpDescription;
      }
      resumedTask.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      this.enqueueTask(resumedTask);
      return { delivered: true };
    }
    if (isManagerEvent && task.agentType === AGENT_IDS.MANAGER) {
      // The orchestration layer persisted the event before calling us. Make
      // that durable row the only report source; a live session refreshes it
      // at the next turn instead of receiving a duplicate prompt copy.
      this.subagentSessions.get(agentId)?.notifyHistoryChanged();
    }
    if (
      isManagerEvent &&
      task.agentType === AGENT_IDS.MANAGER &&
      (task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled")
    ) {
      // Paused/finished managers stay terminal. Their next explicit
      // send_input rebuilds context from the persisted event exactly once.
      return { delivered: true };
    }
    if (options?.parentAgentId) {
      task.parentAgentId = options.parentAgentId;
    }
    if (
      task.agentType === AGENT_IDS.MANAGER &&
      options?.deliveryKind === "external-input"
    ) {
      task.managerReportRequested = true;
    }
    if (task.waitingForManagedChildren && task.status === "pending") {
      task.toSubagentQueue.push(deliveredInput);
      task.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      task.waitingForManagedChildren = false;
      task.pendingStartStatusText = updateStatusText;
      task.pendingStartIsFollowUp = true;
      this.pendingQueue.unshift(task.threadId);
      this.persistTask(task);
      this.tryStartNext();
      return { delivered: true };
    }
    if (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "canceled"
    ) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      task.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
        task.messageLog.splice(
          0,
          task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES,
        );
      }
      if (rootRunId) {
        task.rootRunId = rootRunId;
      }
      if (followUpDescription) {
        task.description = followUpDescription;
      }
      // Same re-activation as the persisted-record path above: the thread
      // row may have been evicted while this task sat terminal in memory.
      this.opts.resolveTaskThread?.({
        conversationId: task.conversationId,
        agentType: task.agentType,
        threadId: task.threadId,
      });
      this.resetTaskForNextAttempt(task, text);
      task.pendingStartStatusText = updateStatusText;
      // Re-activating a terminal thread is a `send_input` follow-up.
      task.pendingStartIsFollowUp = true;
      task.recentActivity = [updateStatusText];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: updateStatusText,
      });
      this.enqueueTask(task);
      return { delivered: true };
    }

    const targetQueue =
      from === "orchestrator" ? task.toSubagentQueue : task.toOrchestratorQueue;
    targetQueue.push(deliveredInput);
    if (targetQueue.length > LocalAgentManager.MAX_QUEUE_MESSAGES) {
      targetQueue.splice(
        0,
        targetQueue.length - LocalAgentManager.MAX_QUEUE_MESSAGES,
      );
    }

    task.messageLog.push({
      from,
      text: truncate(text, 500),
      timestamp: Date.now(),
    });
    if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
      task.messageLog.splice(
        0,
        task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES,
      );
    }

    if (from === "orchestrator") {
      if (rootRunId) {
        task.rootRunId = rootRunId;
      }
      if (followUpDescription) {
        task.description = followUpDescription;
      }
      task.pendingStartStatusText = updateStatusText;
      task.recentActivity = [updateStatusText];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: updateStatusText,
      });

      if (task.status === "running" && !task.controller.signal.aborted) {
        // The follow-up is already in `toSubagentQueue` above. Aborting the
        // in-flight `runSubagent` ends the current assistant turn early so
        // `executeTask`'s post-run dispatch can re-enter via
        // `deliverFollowUpAsNextTurn`, which builds the next user message
        // from the queue. We deliberately do NOT touch `task.prompt` here:
        // it stores the original user goal that gets persisted and is read
        // back on cold rehydration. The long-lived `subagentSession` keeps
        // the actual conversation history, so the LLM's cached prefix is
        // preserved across the re-entry.
        task.interruptedForFollowUp = true;
        task.controller.abort(new Error(AGENT_INPUT_INTERRUPT_ERROR));
      }
    }

    this.persistTask(task);
    return { delivered: true };
  }

  async drainAgentMessages(
    agentId: string,
    recipient: "orchestrator" | "subagent",
  ): Promise<string[]> {
    const task = this.tasks.get(agentId);
    if (!task) return [];
    return this.consumeTaskMessages(task, recipient);
  }
}

const optsValueOrDefault = (
  value: number | undefined,
  fallback: number,
): number => (Number.isFinite(value) ? Math.floor(value!) : fallback);
