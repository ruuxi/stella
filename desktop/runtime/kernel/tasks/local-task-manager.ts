import path from "path";
import type { ToolContext, ToolResult, TaskToolApi, TaskToolRequest, TaskToolSnapshot } from "../tools/types.js";
import { truncate } from "../tools/utils.js";
import type { PersistedTaskRecord } from "../storage/runtime-store.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";

export type LocalTaskManagerAgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  orchestratorReminderText?: string;
  staleUserReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
  toolsAllowlist?: string[];
  model?: string;
  taskDepth?: number;
  maxTaskDepth: number;
  coreMemory?: string;
  threadHistory?: Array<{
    timestamp?: number;
    role: string;
    content: string;
    toolCallId?: string;
    payload?: PersistedRuntimeThreadPayload;
  }>;
  activeThreadId?: string;
  agentEngine?: "default" | "claude_code_local";
  maxAgentConcurrency?: number;
};

export type LocalTaskManagerStatus = "pending" | "running" | "completed" | "error" | "canceled";

type TaskMessageEntry = {
  from: "orchestrator" | "subagent";
  text: string;
  timestamp: number;
};

type RuntimeTaskRecord = {
  id: string;
  conversationId: string;
  rootRunId?: string;
  description: string;
  prompt: string;
  agentType: string;
  taskDepth: number;
  maxTaskDepth?: number;
  status: LocalTaskManagerStatus;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  controller: AbortController;
  storageMode: "cloud" | "local";
  cloudTaskId?: string;
  /** Resolves when the cloud task record has been created (or rejected). */
  cloudCreatePromise?: Promise<void>;
  parentTaskId?: string;
  threadId?: string;
  toolsAllowlistOverride?: string[];
  selfModMetadata?: TaskToolRequest["selfModMetadata"];
  recentActivity: string[];
  progressBuffer: string;
  toSubagentQueue: string[];
  toOrchestratorQueue: string[];
  messageLog: TaskMessageEntry[];
  attemptCount: number;
  restartRequested: boolean;
  terminalEventEmitted: boolean;
};

type FsLock = {
  id: string;
  taskId: string;
  key: string;
};

export type TaskLifecycleEvent = {
  type:
    | "task-started"
    | "task-completed"
    | "task-failed"
    | "task-canceled"
    | "task-progress";
  conversationId: string;
  rootRunId?: string;
  taskId: string;
  agentType: string;
  description?: string;
  parentTaskId?: string;
  result?: string;
  error?: string;
  statusText?: string;
};

type LocalTaskManagerOpts = {
  maxConcurrent?: number;
  getMaxConcurrent?: () => number;
  getStarterTools?: (agentType: string) => string[];
  routeTools?: (args: {
    agentType: string;
    description: string;
    prompt: string;
    loadedTools: string[];
  }) => Promise<string[]>;
  resolveTaskThread?: (args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
  }) => { threadId: string; reused: boolean } | null;
  onTaskEvent?: (event: TaskLifecycleEvent) => void;
  fetchAgentContext: (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
    selfModMetadata?: TaskToolRequest["selfModMetadata"];
  }) => Promise<LocalTaskManagerAgentContext>;
  runSubagent: (args: {
    conversationId: string;
    userMessageId: string;
    agentType: string;
    taskId?: string;
    rootRunId?: string;
    taskDescription: string;
    taskPrompt: string;
    agentContext: LocalTaskManagerAgentContext;
    persistToConvex: boolean;
    enableRemoteTools: boolean;
    abortSignal: AbortSignal;
    selfModMetadata?: TaskToolRequest["selfModMetadata"];
    onProgress?: (chunk: string) => void;
    onToolStart?: (event: { runId: string; seq: number; toolCallId: string; toolName: string }) => void;
    onToolEnd?: (event: { runId: string; seq: number; toolCallId: string; toolName: string; resultPreview: string; html?: string }) => void;
    toolExecutor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
    ) => Promise<ToolResult>;
  }) => Promise<{ runId: string; result: string; error?: string }>;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  createCloudTaskRecord: (args: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType: string;
    parentTaskId?: string;
    maxTaskDepth?: number;
  }) => Promise<{ taskId: string }>;
  completeCloudTaskRecord: (args: {
    taskId: string;
    status: "completed" | "error" | "canceled";
    result?: string;
    error?: string;
  }) => Promise<void>;
  getCloudTaskRecord: (taskId: string) => Promise<TaskToolSnapshot | null>;
  cancelCloudTaskRecord: (taskId: string, reason?: string) => Promise<{ canceled: boolean }>;
  saveTaskRecord?: (record: PersistedTaskRecord) => void;
  getTaskRecord?: (threadId: string) => PersistedTaskRecord | null;
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const mergeToolNames = (...lists: Array<string[] | undefined>): string[] => {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const value of list ?? []) {
      const toolName = normalizeString(value);
      if (!toolName || seen.has(toolName)) continue;
      seen.add(toolName);
      merged.push(toolName);
    }
  }
  return merged;
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
      String.raw`(?:^|\s)(?:"(${BASH_PATH_PATTERN}[^"]+)"|'(${BASH_PATH_PATTERN}[^']+)'|(${BASH_PATH_PATTERN}[^\s"'` + "`" + String.raw`]+))`,
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const getFsLockKey = (
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): string | null => {
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = normalizeString(args.file_path ?? args.path ?? args.target_path);
    if (!filePath) return "*";
    return normalizeFsPathKey(
      filePath,
      normalizeString(args.working_directory ?? args.cwd ?? context?.frontendRoot),
    );
  }
  if (toolName === "Bash") {
    const command = normalizeString(args.command);
    if (!command) return "*";
    const pathFromCommand = extractBashPath(command);
    if (!pathFromCommand) return "*";
    return normalizeFsPathKey(
      pathFromCommand,
      normalizeString(args.working_directory ?? args.cwd ?? context?.frontendRoot),
    );
  }
  return null;
};

const isTaskCreateTool = (toolName: string): boolean =>
  toolName === "TaskCreate";

const TASK_UPDATE_INTERRUPT_ERROR = "Interrupted by task update";
export const TASK_SHUTDOWN_CANCEL_REASON = "Canceled because Stella closed or restarted.";

export class LocalTaskManager implements TaskToolApi {
  private readonly defaultMaxConcurrent: number;
  private readonly opts: LocalTaskManagerOpts;
  private readonly tasks = new Map<string, RuntimeTaskRecord>();
  private readonly pendingQueue: string[] = [];
  private runningCount = 0;
  private readonly activeFsLocks: FsLock[] = [];
  private readonly fsLockWaiters: Array<() => void> = [];
  private static readonly MAX_QUEUE_MESSAGES = 32;
  private static readonly MAX_LOG_MESSAGES = 80;
  private nextId = 0;

  constructor(opts: LocalTaskManagerOpts) {
    this.opts = opts;
    this.defaultMaxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
  }

  private consumeTaskMessages(
    task: RuntimeTaskRecord,
    recipient: "orchestrator" | "subagent",
  ): string[] {
    const queue = recipient === "subagent" ? task.toSubagentQueue : task.toOrchestratorQueue;
    if (queue.length === 0) return [];
    const out = [...queue];
    queue.length = 0;
    return out;
  }

  private buildTaskPrompt(task: RuntimeTaskRecord): string {
    const updates = this.consumeTaskMessages(task, "subagent");
    if (updates.length === 0) {
      return task.prompt;
    }

    const updateBlock = updates.map((text, index) => `${index + 1}. ${text}`).join("\n");
    if (task.attemptCount === 0) {
      return [
        task.prompt,
        "Task updates from orchestrator:",
        updateBlock,
        "Apply these updates while completing the task. Newer updates override conflicting earlier instructions.",
      ].join("\n\n");
    }

    return [
      "Task update from orchestrator:",
      updateBlock,
      "Your previous attempt was interrupted so you can apply this update immediately. Continue the same task and treat newer updates as higher priority than conflicting earlier instructions.",
    ].join("\n\n");
  }

  private shouldRestartTask(task: RuntimeTaskRecord): boolean {
    return task.restartRequested && task.status !== "canceled";
  }

  private toPersistedStatus(
    status: LocalTaskManagerStatus,
  ): PersistedTaskRecord["status"] {
    return status === "pending" ? "running" : status;
  }

  private persistTask(task: RuntimeTaskRecord): void {
    this.opts.saveTaskRecord?.({
      threadId: task.id,
      conversationId: task.conversationId,
      agentType: task.agentType,
      description: task.description,
      taskDepth: task.taskDepth,
      ...(typeof task.maxTaskDepth === "number"
        ? { maxTaskDepth: task.maxTaskDepth }
        : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.toolsAllowlistOverride
        ? { toolsAllowlistOverride: task.toolsAllowlistOverride }
        : {}),
      ...(task.selfModMetadata ? { selfModMetadata: task.selfModMetadata } : {}),
      status: this.toPersistedStatus(task.status),
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      ...(typeof task.result === "string" ? { result: task.result } : {}),
      ...(typeof task.error === "string" ? { error: task.error } : {}),
      updatedAt: Date.now(),
    });
  }

  private buildTaskSnapshot(task: RuntimeTaskRecord): TaskToolSnapshot {
    return {
      id: task.id,
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

  private buildPersistedSnapshot(record: PersistedTaskRecord): TaskToolSnapshot {
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

  private resetTaskForNextAttempt(task: RuntimeTaskRecord, prompt: string): void {
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
    task.restartRequested = false;
    task.terminalEventEmitted = false;
  }

  private async buildInitialToolsAllowlist(
    request: TaskToolRequest,
  ): Promise<string[] | undefined> {
    const starterTools = mergeToolNames(
      this.opts.getStarterTools?.(request.agentType),
      request.toolsAllowlistOverride,
    );
    return starterTools.length > 0 ? starterTools : undefined;
  }

  private hydrateTaskFromRecord(
    record: PersistedTaskRecord,
    prompt: string,
  ): RuntimeTaskRecord {
    return {
      id: record.threadId,
      conversationId: record.conversationId,
      description: record.description,
      prompt,
      agentType: record.agentType,
      taskDepth: record.taskDepth,
      maxTaskDepth: record.maxTaskDepth,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller: new AbortController(),
      storageMode: "local",
      parentTaskId: record.parentTaskId,
      threadId: record.threadId,
      toolsAllowlistOverride: record.toolsAllowlistOverride,
      selfModMetadata: record.selfModMetadata,
      recentActivity: [`Continuing thread: ${truncate(prompt, 200)}`],
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      attemptCount: 0,
      restartRequested: false,
      terminalEventEmitted: false,
    };
  }

  private enqueueTask(task: RuntimeTaskRecord, prioritize = false): void {
    this.tasks.set(task.id, task);
    if (prioritize) {
      this.pendingQueue.unshift(task.id);
    } else {
      this.pendingQueue.push(task.id);
    }
    this.persistTask(task);
    this.tryStartNext();
  }

  private requeueTaskForUpdate(task: RuntimeTaskRecord): void {
    this.resetTaskForNextAttempt(task, task.prompt);
    task.recentActivity = ["Applying task update from orchestrator."];
    this.pendingQueue.unshift(task.id);
    this.persistTask(task);
  }

  private tryStartNext(): void {
    const maxConcurrent = Math.max(
      1,
      optsValueOrDefault(this.opts.getMaxConcurrent?.(), this.defaultMaxConcurrent),
    );
    while (this.runningCount < maxConcurrent && this.pendingQueue.length > 0) {
      const taskId = this.pendingQueue.shift();
      if (!taskId) break;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "pending") {
        continue;
      }
      this.runningCount += 1;
      task.status = "running";
      this.persistTask(task);
      this.opts.onTaskEvent?.({
        type: "task-started",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        taskId: task.id,
        agentType: task.agentType,
        description: task.description,
        parentTaskId: task.parentTaskId,
      });
      void this.executeTask(task)
        .catch(() => undefined)
        .finally(() => {
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.tryStartNext();
        });
    }
  }

  private acquireFsLock(taskId: string, key: string): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = () => {
        const conflicting = this.activeFsLocks.some(
          (lock) => lock.taskId !== taskId && pathsOverlap(lock.key, key),
        );
        if (conflicting) {
          this.fsLockWaiters.push(attempt);
          return;
        }
        const lock: FsLock = {
          id: `${taskId}:${++this.nextId}`,
          taskId,
          key,
        };
        this.activeFsLocks.push(lock);
        resolve(() => {
          const index = this.activeFsLocks.findIndex((entry) => entry.id === lock.id);
          if (index >= 0) {
            this.activeFsLocks.splice(index, 1);
          }
          const waiters = this.fsLockWaiters.splice(0, this.fsLockWaiters.length);
          for (const waiter of waiters) {
            queueMicrotask(waiter);
          }
        });
      };
      attempt();
    });
  }

  private async executeTask(task: RuntimeTaskRecord): Promise<void> {
    try {
      const runId = `run:${task.id}:${++this.nextId}`;
      const context = await this.opts.fetchAgentContext({
        conversationId: task.conversationId,
        agentType: task.agentType,
        runId,
        threadId: task.threadId,
        selfModMetadata: task.selfModMetadata,
      });

      context.maxTaskDepth =
        typeof task.maxTaskDepth === "number"
          ? Math.min(context.maxTaskDepth, task.maxTaskDepth)
          : context.maxTaskDepth;
      context.taskDepth = task.taskDepth;

      if (task.toolsAllowlistOverride) {
        context.toolsAllowlist = task.toolsAllowlistOverride;
      }

      const taskPrompt = this.buildTaskPrompt(task);
      task.attemptCount += 1;

      const result = await this.opts.runSubagent({
        conversationId: task.conversationId,
        userMessageId: runId,
        agentType: task.agentType,
        ...(task.cloudTaskId ? { taskId: task.cloudTaskId } : {}),
        rootRunId: task.rootRunId,
        taskDescription: task.description,
        taskPrompt,
        agentContext: context,
        persistToConvex: task.storageMode === "cloud",
        enableRemoteTools: true,
        abortSignal: task.controller.signal,
        selfModMetadata: task.selfModMetadata,
        onProgress: (chunk) => {
          if (task.controller.signal.aborted || task.status === "canceled") return;
          if (typeof chunk !== "string" || !chunk) return;
          task.progressBuffer += chunk;
          if (task.progressBuffer.length > 4_000) {
            task.progressBuffer = task.progressBuffer.slice(task.progressBuffer.length - 4_000);
          }
          const compact = task.progressBuffer.replace(/\s+/g, " ").trim();
          if (!compact) return;
          task.recentActivity = [truncate(compact, 500)];
        },
        onToolStart: (ev) => this.opts.onTaskEvent?.({
          type: "task-progress",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          taskId: task.id,
          agentType: task.agentType,
          statusText: `Using ${ev.toolName}`,
        }),
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
          if (task.storageMode === "cloud" && isTaskCreateTool(toolName) && task.cloudCreatePromise) {
            await task.cloudCreatePromise.catch(() => undefined);
          }
          const scopedContext: ToolContext = {
            ...toolContext,
            taskId: task.id,
            ...(task.cloudTaskId ? { cloudTaskId: task.cloudTaskId } : {}),
            taskDepth: task.taskDepth,
            maxTaskDepth: context.maxTaskDepth,
          };
          const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
          if (!lockKey) {
            return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
          }
          const release = await this.acquireFsLock(task.id, lockKey);
          try {
            return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
          } finally {
            release();
          }
        },
      });

      task.completedAt = Date.now();
      if (this.shouldRestartTask(task)) {
        // The update path aborts the active subagent run on purpose and immediately requeues.
      } else if (task.controller.signal.aborted || task.status === "canceled") {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else if (result.error) {
        task.status = "error";
        task.error = result.error;
      } else {
        task.status = "completed";
        task.result = result.result;
      }
    } catch (error) {
      task.completedAt = Date.now();
      if (this.shouldRestartTask(task)) {
        // The update path aborts the active subagent run on purpose and immediately requeues.
      } else if (task.controller.signal.aborted) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else {
        task.status = "error";
        task.error = (error as Error).message ?? "Task failed";
      }
    }

    if (this.shouldRestartTask(task)) {
      this.requeueTaskForUpdate(task);
      return;
    }

    this.persistTask(task);

    // Emit task lifecycle event
    if (!task.terminalEventEmitted) {
      if (task.status === "completed") {
        this.opts.onTaskEvent?.({
          type: "task-completed",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          taskId: task.id,
          agentType: task.agentType,
          result: task.result ? truncate(task.result, 500) : undefined,
        });
      } else if (task.status === "error") {
        this.opts.onTaskEvent?.({
          type: "task-failed",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          taskId: task.id,
          agentType: task.agentType,
          error: task.error,
        });
      } else if (task.status === "canceled") {
        this.opts.onTaskEvent?.({
          type: "task-canceled",
          conversationId: task.conversationId,
          rootRunId: task.rootRunId,
          taskId: task.id,
          agentType: task.agentType,
          description: task.description,
          parentTaskId: task.parentTaskId,
          error: task.error,
        });
      }
      task.terminalEventEmitted = true;
    }

    // Sync task completion to Convex in background (non-blocking)
    if (task.storageMode === "cloud") {
      void (async () => {
        // Wait for cloud task creation to finish so we have the cloudTaskId
        if (task.cloudCreatePromise) {
          await task.cloudCreatePromise.catch(() => {});
        }
        if (!task.cloudTaskId) return;
        const status =
          task.status === "completed"
            ? "completed"
            : task.status === "canceled"
              ? "canceled"
              : "error";
        await this.opts.completeCloudTaskRecord({
          taskId: task.cloudTaskId,
          status,
          result: task.result ? truncate(task.result, 30_000) : undefined,
          error: task.error ? truncate(task.error, 10_000) : undefined,
        }).catch(() => {
          // Background sync failure — task is still tracked locally
        });
      })();
    }
  }

  async createTask(request: TaskToolRequest): Promise<{ threadId: string }> {
    const controller = new AbortController();
    const initialToolsAllowlist = await this.buildInitialToolsAllowlist(request);
    const resolvedThread = this.opts.resolveTaskThread?.({
      conversationId: request.conversationId,
      agentType: request.agentType,
      threadId: request.threadId,
    }) ?? null;
    const id =
      resolvedThread?.threadId ??
      request.threadId ??
      `task-${++this.nextId}`;

    const task: RuntimeTaskRecord = {
      id,
      conversationId: request.conversationId,
      rootRunId: request.rootRunId,
      description: request.description,
      prompt: request.prompt,
      agentType: request.agentType,
      taskDepth: Math.max(1, request.taskDepth ?? 1),
      maxTaskDepth:
        typeof request.maxTaskDepth === "number"
          ? Math.max(1, Math.floor(request.maxTaskDepth))
          : undefined,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller,
      storageMode: request.storageMode,
      parentTaskId: request.parentTaskId,
      threadId: id,
      toolsAllowlistOverride: initialToolsAllowlist,
      selfModMetadata: request.selfModMetadata,
      recentActivity: [],
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      attemptCount: 0,
      restartRequested: false,
      terminalEventEmitted: false,
    };

    // Create cloud record in background (non-blocking)
    // Store the promise so completion can await it before syncing status.
    if (request.storageMode === "cloud") {
      const cloudParentTaskId =
        request.parentTaskId && !this.tasks.has(request.parentTaskId)
          ? request.parentTaskId
          : undefined;
      task.cloudCreatePromise = this.opts.createCloudTaskRecord({
        conversationId: request.conversationId,
        description: request.description,
        prompt: request.prompt,
        agentType: request.agentType,
        parentTaskId: cloudParentTaskId,
        maxTaskDepth: task.maxTaskDepth,
      }).then((created) => {
        task.cloudTaskId = created.taskId;
      }).catch(() => {
        // Cloud record creation failed — task runs locally only
      });
    }

    this.enqueueTask(task);
    return {
      threadId: task.id,
    };
  }

  async loadTools(
    taskId: string,
    prompt: string,
  ): Promise<{ addedTools: string[]; currentTools: string[] }> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { addedTools: [], currentTools: [] };
    }
    const requestPrompt = prompt.trim();
    if (!requestPrompt || !this.opts.routeTools) {
      return {
        addedTools: [],
        currentTools: task.toolsAllowlistOverride ?? [],
      };
    }
    const currentTools = mergeToolNames(
      this.opts.getStarterTools?.(task.agentType),
      task.toolsAllowlistOverride,
    );
    const routedTools = await this.opts
      .routeTools({
        agentType: task.agentType,
        description: task.description,
        prompt: requestPrompt,
        loadedTools: currentTools,
      })
      .catch(() => []);
    const mergedTools = mergeToolNames(currentTools, routedTools);
    const addedTools = mergedTools.filter((tool) => !currentTools.includes(tool));
    if (addedTools.length === 0) {
      return { addedTools: [], currentTools };
    }
    task.toolsAllowlistOverride = mergedTools;
    this.persistTask(task);
    return { addedTools, currentTools: mergedTools };
  }

  async getTask(taskId: string): Promise<TaskToolSnapshot | null> {
    const local = this.tasks.get(taskId);
    if (local) {
      return this.buildTaskSnapshot(local);
    }
    const persisted = this.opts.getTaskRecord?.(taskId);
    if (persisted) {
      return this.buildPersistedSnapshot(persisted);
    }
    return await this.opts.getCloudTaskRecord(taskId);
  }

  getTaskCount(): number {
    return this.tasks.size;
  }

  shutdown(reason = TASK_SHUTDOWN_CANCEL_REASON): void {
    for (const task of this.tasks.values()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }
      void this.cancelTask(task.id, reason);
    }
  }

  async cancelTask(taskId: string, reason?: string): Promise<{ canceled: boolean }> {
    const local = this.tasks.get(taskId);
    if (local) {
      if (local.status === "completed" || local.status === "error" || local.status === "canceled") {
        return { canceled: true };
      }
      const previousStatus = local.status;
      local.error = reason ?? "Canceled";
      local.status = "canceled";
      local.completedAt = Date.now();
      local.restartRequested = false;
      local.controller.abort(new Error(local.error));
      if (!local.terminalEventEmitted && (previousStatus === "pending" || previousStatus === "running")) {
        this.opts.onTaskEvent?.({
          type: "task-canceled",
          conversationId: local.conversationId,
          rootRunId: local.rootRunId,
          taskId: local.id,
          agentType: local.agentType,
          description: local.description,
          parentTaskId: local.parentTaskId,
          error: local.error,
        });
        local.terminalEventEmitted = true;
      }
      this.persistTask(local);
      if (local.storageMode === "cloud" && local.cloudTaskId) {
        await this.opts.cancelCloudTaskRecord(local.cloudTaskId, local.error);
      }
      return { canceled: true };
    }
    const persisted = this.opts.getTaskRecord?.(taskId);
    if (persisted) {
      if (persisted.status === "running") {
        this.opts.saveTaskRecord?.({
          ...persisted,
          status: "canceled",
          completedAt: Date.now(),
          error: reason ?? "Canceled",
          updatedAt: Date.now(),
        });
      }
      return { canceled: true };
    }
    return await this.opts.cancelCloudTaskRecord(taskId, reason);
  }

  async sendTaskMessage(
    taskId: string,
    message: string,
    from: "orchestrator" | "subagent",
  ): Promise<{ delivered: boolean }> {
    const text = message.trim();
    if (!text) return { delivered: false };
    const task = this.tasks.get(taskId);
    if (!task) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      const persisted = this.opts.getTaskRecord?.(taskId);
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
    if (task.status === "completed" || task.status === "error" || task.status === "canceled") {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      task.messageLog.push({ from, text: truncate(text, 500), timestamp: Date.now() });
      if (task.messageLog.length > LocalTaskManager.MAX_LOG_MESSAGES) {
        task.messageLog.splice(0, task.messageLog.length - LocalTaskManager.MAX_LOG_MESSAGES);
      }
      this.resetTaskForNextAttempt(task, text);
      this.enqueueTask(task);
      return { delivered: true };
    }

    const targetQueue = from === "orchestrator" ? task.toSubagentQueue : task.toOrchestratorQueue;
    targetQueue.push(text);
    if (targetQueue.length > LocalTaskManager.MAX_QUEUE_MESSAGES) {
      targetQueue.splice(0, targetQueue.length - LocalTaskManager.MAX_QUEUE_MESSAGES);
    }

    task.messageLog.push({ from, text: truncate(text, 500), timestamp: Date.now() });
    if (task.messageLog.length > LocalTaskManager.MAX_LOG_MESSAGES) {
      task.messageLog.splice(0, task.messageLog.length - LocalTaskManager.MAX_LOG_MESSAGES);
    }

    if (from === "orchestrator") {
      task.recentActivity = [`Task update received: ${truncate(text, 200)}`];
      this.opts.onTaskEvent?.({
        type: "task-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        taskId: task.id,
        agentType: task.agentType,
        statusText: "Applying task update",
      });

      if (task.status === "running" && !task.controller.signal.aborted) {
        task.restartRequested = true;
        task.prompt = text;
        task.controller.abort(new Error(TASK_UPDATE_INTERRUPT_ERROR));
      }
    }

    this.persistTask(task);
    return { delivered: true };
  }

  async drainTaskMessages(
    taskId: string,
    recipient: "orchestrator" | "subagent",
  ): Promise<string[]> {
    const task = this.tasks.get(taskId);
    if (!task) return [];
    return this.consumeTaskMessages(task, recipient);
  }
}

const optsValueOrDefault = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.floor(value!) : fallback;
