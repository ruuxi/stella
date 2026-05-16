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
 * in-flight assistant turn. So `send_input` with `interrupt: true` aborts
 * the current `runSubagent` (ending the in-flight assistant turn early)
 * and re-enters with the follow-up as the next user message;
 * `interrupt: false` just waits for `runSubagent` to return naturally
 * and then re-enters. Both paths funnel through
 * `deliverFollowUpAsNextTurn` → `tryStartNext` → `executeTask` →
 * `runSubagent`.
 */

import path from "path";
import type {
  TaskLifecycleStatus,
  TerminalTaskLifecycleStatus,
} from "../../contracts/agent-runtime.js";
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
import { truncate } from "../tools/utils.js";
import type { PersistedAgentRecord } from "../storage/runtime-store.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import type { RuntimeThreadRecord } from "../runtime-threads.js";
import type { ReasoningEffort } from "../preferences/local-preferences.js";
import {
  type SubagentSession,
  getOrCreateSubagentSession,
} from "../agent-runtime/subagent-session.js";

export type LocalAgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  orchestratorReminderText?: string;
  staleUserReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
  toolsAllowlist?: string[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  agentDepth?: number;
  maxAgentDepth: number;
  coreMemory?: string;
  threadHistory?: Array<{
    timestamp?: number;
    role: string;
    content: string;
    toolCallId?: string;
    payload?: PersistedRuntimeThreadPayload;
    customMessage?: RuntimeThreadMessage["customMessage"];
  }>;
  activeThreadId?: string;
  agentEngine?: "default" | "claude_code_local";
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
  toolWorkspaceRoot?: string;
  agentDepth: number;
  maxAgentDepth?: number;
  status: LocalAgentStatus;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  error?: string;
  controller: AbortController;
  storageMode: "cloud" | "local";
  cloudAgentId?: string;
  /** Resolves when the cloud task record has been created (or rejected). */
  cloudCreatePromise?: Promise<void>;
  parentAgentId?: string;
  selfModMetadata?: AgentToolRequest["selfModMetadata"];
  recentActivity: string[];
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
   * Set by `send_input` with `interrupt: true` when the current
   * `runSubagent` call has been aborted so we can deliver the queued
   * follow-up as the next user turn on the same session. The post-run
   * branch in `executeTask` checks this to decide whether to fall
   * through into `deliverFollowUpAsNextTurn` (treat as continuation)
   * vs. treating the abort as a real cancellation.
   *
   * Not "restart" — the long-lived `subagentSession` is reused; only
   * the outer `executeTask` invocation re-enters.
   */
  interruptedForFollowUp: boolean;
  terminalEventEmitted: boolean;
  pendingStartStatusText?: string;
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
    | "agent-progress";
  conversationId: string;
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
};

type LocalAgentManagerOpts = {
  maxConcurrent?: number;
  getMaxConcurrent?: () => number;
  resolveTaskThread?: (args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
  }) => { threadId: string; reused: boolean } | null;
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
  fetchAgentContext: (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
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
        args.working_directory ?? args.cwd ?? context?.stellaRoot,
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
        args.working_directory ?? args.cwd ?? context?.stellaRoot,
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
  toolName === "spawn_agent";

const AGENT_INPUT_INTERRUPT_ERROR = "Interrupted by agent input";
export const AGENT_SHUTDOWN_CANCEL_REASON =
  "Canceled because Stella closed or restarted.";
// Sentinel set by the orchestrator's pause_agent tool so the runner
// can suppress the hidden `[Task canceled]` follow-up turn that would
// otherwise replace the user-facing reply with an empty silence.
export const AGENT_PAUSE_CANCEL_REASON = "Paused by orchestrator.";

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

  private resetTaskForNextAttempt(
    task: RuntimeAgentRecord,
    prompt: string,
  ): void {
    task.prompt = prompt;
    task.status = "pending";
    task.startedAt = Date.now();
    task.completedAt = null;
    task.result = undefined;
    task.error = undefined;
    task.progressBuffer = "";
    task.recentActivity = [`Continuing thread: ${truncate(prompt, 200)}`];
    task.toSubagentQueue.length = 0;
    task.toOrchestratorQueue.length = 0;
    task.controller = new AbortController();
    task.interruptedForFollowUp = false;
    task.terminalEventEmitted = false;
    task.pendingStartStatusText = undefined;
  }

  private hydrateTaskFromRecord(
    record: PersistedAgentRecord,
    prompt: string,
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
      recentActivity: [`Continuing thread: ${truncate(prompt, 200)}`],
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
      pendingStartStatusText: "Updating",
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
   * Reached from two paths in `executeTask`:
   *   - `interrupt: true` send_input aborted the in-flight `runSubagent`
   *     and we want to deliver the follow-up immediately
   *     (`shouldDeliverFollowUp` true).
   *   - `interrupt: false` send_input queued during a run that then
   *     completed naturally; we owe the agent one more turn to apply
   *     the queued instruction.
   */
  private deliverFollowUpAsNextTurn(task: RuntimeAgentRecord): void {
    const prompt = this.buildTaskPrompt(task);
    this.resetTaskForNextAttempt(task, prompt);
    task.recentActivity = ["Applying task update from orchestrator."];
    this.pendingQueue.unshift(task.threadId);
    this.persistTask(task);
  }

  private tryStartNext(): void {
    const maxConcurrent = Math.max(
      1,
      optsValueOrDefault(
        this.opts.getMaxConcurrent?.(),
        this.defaultMaxConcurrent,
      ),
    );
    while (this.runningCount < maxConcurrent && this.pendingQueue.length > 0) {
      const threadId = this.pendingQueue.shift();
      if (!threadId) break;
      const task = this.tasks.get(threadId);
      if (!task || task.status !== "pending") {
        continue;
      }
      this.runningCount += 1;
      task.status = "running";
      const startStatusText = task.pendingStartStatusText ?? task.description;
      task.pendingStartStatusText = undefined;
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
      });
      logWorkingIndicatorTrace("[stella:working-indicator:agent-started]", {
        threadId: task.threadId,
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        description: task.description,
        statusText: startStatusText,
      });
      void this.executeTask(task)
        .catch(() => undefined)
        .finally(() => {
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.tryStartNext();
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

  private async executeTask(task: RuntimeAgentRecord): Promise<void> {
    try {
      const runId = `run:${task.threadId}:${++this.nextId}`;
      const context = await this.opts.fetchAgentContext({
        conversationId: task.conversationId,
        agentType: task.agentType,
        runId,
        threadId: task.threadId,
        ...(task.toolWorkspaceRoot
          ? { toolWorkspaceRoot: task.toolWorkspaceRoot }
          : {}),
        selfModMetadata: task.selfModMetadata,
      });

      context.maxAgentDepth =
        typeof task.maxAgentDepth === "number"
          ? Math.min(context.maxAgentDepth, task.maxAgentDepth)
          : context.maxAgentDepth;
      context.agentDepth = task.agentDepth;

      const taskPrompt = this.buildTaskPrompt(task);
      task.turnCount += 1;

      // Long-lived session for this durable threadId. First attempt builds
      // the Pi `Agent`; restart-on-input attempts reuse it. Disposed when
      // the task terminates (see end of `executeTask`).
      const subagentSession = getOrCreateSubagentSession(
        this.subagentSessions,
        task.threadId,
        task.conversationId,
        task.agentType,
      );

      const result = await this.opts.runSubagent({
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
        abortSignal: task.controller.signal,
        selfModMetadata: task.selfModMetadata,
        onProgress: (chunk) => {
          if (task.controller.signal.aborted || task.status === "canceled")
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
        },
        onToolStart: (ev) => {
          // Once cancelAgent has marked this task canceled, suppress any
          // in-flight `tool_execution_start` events from the agent loop —
          // those would otherwise leak `agent-progress` lifecycle events
          // after `agent-canceled`, leaving a phantom "Working … Task" chip
          // in the footer that re-adds the task to the live UI state.
          if (task.controller.signal.aborted || task.status === "canceled") {
            return;
          }
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText: `Using ${ev.toolName}`,
          });
          logWorkingIndicatorTrace(
            "[stella:working-indicator:agent-progress]",
            {
              threadId: task.threadId,
              conversationId: task.conversationId,
              rootRunId: task.rootRunId,
              description: task.description,
              statusText: `Using ${ev.toolName}`,
            },
          );
        },
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
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

      task.completedAt = Date.now();
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` with `interrupt: true` aborted the current
        // `runSubagent` on purpose so we can deliver the queued
        // follow-up as the next user turn on the same session. The
        // dispatch at the end of this method calls
        // `deliverFollowUpAsNextTurn`; status stays in its current
        // state so the dispatch can read `interruptedForFollowUp`.
      } else if (task.controller.signal.aborted || task.status === "canceled") {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else if (result.error) {
        task.status = "error";
        task.error = result.error;
      } else {
        task.status = "completed";
        task.result = result.result;
        task.fileChanges = result.fileChanges;
        task.producedFiles = result.producedFiles;
      }
    } catch (error) {
      task.completedAt = Date.now();
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` with `interrupt: true` aborted the current
        // `runSubagent` on purpose; see comment above.
      } else if (task.controller.signal.aborted) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else {
        task.status = "error";
        task.error = (error as Error).message ?? "Task failed";
      }
    }

    if (
      this.shouldDeliverFollowUp(task) ||
      (task.toSubagentQueue.length > 0 && task.status === "completed")
    ) {
      this.deliverFollowUpAsNextTurn(task);
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
        this.opts.onAgentEvent?.({
          type: "agent-completed",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          result: task.result,
          ...(task.fileChanges?.length
            ? { fileChanges: task.fileChanges }
            : {}),
          ...(task.producedFiles?.length
            ? { producedFiles: task.producedFiles }
            : {}),
        });
      } else if (task.status === "error") {
        this.opts.onAgentEvent?.({
          type: "agent-failed",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          error: task.error,
        });
      } else if (task.status === "canceled") {
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: task.conversationId,
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
    const controller = new AbortController();
    const resolvedThread =
      this.opts.resolveTaskThread?.({
        conversationId: request.conversationId,
        agentType: request.agentType,
        threadId: request.threadId,
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
      recentActivity: [],
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
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

    this.enqueueTask(task);
    return {
      threadId: task.threadId,
      activeThreads: this.opts.listActiveThreads?.(request.conversationId),
    };
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

  shutdown(reason = AGENT_SHUTDOWN_CANCEL_REASON): void {
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
        return { canceled: true };
      }
      const previousStatus = local.status;
      local.error = reason ?? "Canceled";
      local.status = "canceled";
      local.completedAt = Date.now();
      local.interruptedForFollowUp = false;
      local.pendingStartStatusText = undefined;
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
      return { canceled: true };
    }
    return await this.opts.cancelCloudAgentRecord(agentId, reason);
  }

  async sendAgentMessage(
    agentId: string,
    message: string,
    from: "orchestrator" | "subagent",
    options?: { interrupt?: boolean },
  ): Promise<{ delivered: boolean }> {
    const text = message.trim();
    if (!text) return { delivered: false };
    // `interrupt` only applies when the orchestrator addresses a still-running
    // agent; in every other path (subagent->orchestrator, paused/completed
    // re-hydration, hydrating from persisted record) the message is the only
    // thing in flight, so there is nothing to abort.
    const interrupt = options?.interrupt !== false;
    const task = this.tasks.get(agentId);
    if (!task) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      const persisted = this.opts.getAgentRecord?.(agentId);
      if (!persisted) {
        return { delivered: false };
      }
      const resumedTask = this.hydrateTaskFromRecord(persisted, text);
      resumedTask.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      this.enqueueTask(resumedTask);
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
      this.resetTaskForNextAttempt(task, text);
      const resumeActivity = task.description;
      task.pendingStartStatusText = "Updating";
      task.recentActivity = ["Updating."];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: "Updating",
      });
      this.enqueueTask(task);
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: resumeActivity,
      });
      return { delivered: true };
    }

    const targetQueue =
      from === "orchestrator" ? task.toSubagentQueue : task.toOrchestratorQueue;
    targetQueue.push(text);
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
      const previousActivity = task.recentActivity[0] ?? task.description;
      const statusText = interrupt ? "Updating" : "Queued";
      task.recentActivity = [
        interrupt
          ? `Update received: ${truncate(text, 200)}`
          : `Queued update: ${truncate(text, 200)}`,
      ];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText,
      });

      if (
        interrupt &&
        task.status === "running" &&
        !task.controller.signal.aborted
      ) {
        // The follow-up is already in `toSubagentQueue` above. Aborting
        // the in-flight `runSubagent` ends the current assistant turn
        // early so `executeTask`'s post-run dispatch can re-enter via
        // `deliverFollowUpAsNextTurn`, which builds the next user
        // message from the queue. We deliberately do NOT touch
        // `task.prompt` here — it stores the original user goal that
        // gets persisted and is read back on cold rehydration. The
        // long-lived `subagentSession` keeps the actual conversation
        // history, so the LLM's cached prefix is preserved across the
        // re-entry.
        task.interruptedForFollowUp = true;
        task.controller.abort(new Error(AGENT_INPUT_INTERRUPT_ERROR));
      }
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: previousActivity,
      });
      task.recentActivity = [previousActivity];
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
