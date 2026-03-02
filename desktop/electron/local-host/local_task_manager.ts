import crypto from "crypto";
import path from "path";
import type { ToolContext, ToolResult, TaskToolApi, TaskToolRequest, TaskToolSnapshot } from "./tools-types.js";
import { truncate } from "./tools-utils.js";

export type LocalTaskManagerAgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  toolsAllowlist?: string[];
  model: string;
  fallbackModel?: string;
  maxTaskDepth: number;
  defaultSkills: string[];
  skillIds: string[];
  coreMemory?: string;
  threadHistory?: Array<{ role: string; content: string; toolCallId?: string }>;
  activeThreadId?: string;
  generalAgentEngine?: "default" | "codex_local" | "claude_code_local";
  codexLocalMaxConcurrency?: number;
  proxyToken: {
    token: string;
    expiresAt: number;
  };
};

export type LocalTaskManagerStatus = "pending" | "running" | "completed" | "error" | "canceled";

type RuntimeTaskRecord = {
  id: string;
  conversationId: string;
  description: string;
  prompt: string;
  agentType: string;
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
  threadName?: string;
  commandId?: string;
  systemPromptOverride?: string;
  recentActivity: string[];
  progressBuffer: string;
};

type FsLock = {
  id: string;
  taskId: string;
  key: string;
};

type LocalTaskManagerOpts = {
  maxConcurrent?: number;
  fetchAgentContext: (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
  }) => Promise<LocalTaskManagerAgentContext>;
  runSubagent: (args: {
    conversationId: string;
    userMessageId: string;
    agentType: string;
    taskId?: string;
    taskDescription: string;
    taskPrompt: string;
    agentContext: LocalTaskManagerAgentContext;
    persistToConvex: boolean;
    enableRemoteTools: boolean;
    abortSignal: AbortSignal;
    onProgress?: (chunk: string) => void;
    toolExecutor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<ToolResult>;
  }) => Promise<{ runId: string; result: string; error?: string }>;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<ToolResult>;
  createCloudTaskRecord: (args: {
    conversationId: string;
    description: string;
    prompt: string;
    agentType: string;
    parentTaskId?: string;
    commandId?: string;
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

const extractBashPath = (command: string): string | undefined => {
  const match = command.match(/(?:^|\s)(\/[^\s"'`]+|\.\.?\/[^\s"'`]+)/);
  return match ? match[1] : undefined;
};

const getFsLockKey = (
  toolName: string,
  args: Record<string, unknown>,
): string | null => {
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = normalizeString(args.file_path ?? args.path ?? args.target_path);
    if (!filePath) return "*";
    return normalizeFsPathKey(
      filePath,
      normalizeString(args.working_directory ?? args.cwd),
    );
  }
  if (toolName === "Bash" || toolName === "SkillBash") {
    const command = normalizeString(args.command);
    if (!command) return "*";
    const pathFromCommand = extractBashPath(command);
    if (!pathFromCommand) return "*";
    return normalizeFsPathKey(
      pathFromCommand,
      normalizeString(args.working_directory ?? args.cwd),
    );
  }
  return null;
};

export class LocalTaskManager implements TaskToolApi {
  private readonly maxConcurrent: number;
  private readonly opts: LocalTaskManagerOpts;
  private readonly tasks = new Map<string, RuntimeTaskRecord>();
  private readonly pendingQueue: string[] = [];
  private runningCount = 0;
  private readonly activeFsLocks: FsLock[] = [];
  private readonly fsLockWaiters: Array<() => void> = [];

  constructor(opts: LocalTaskManagerOpts) {
    this.opts = opts;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
  }

  private tryStartNext(): void {
    while (this.runningCount < this.maxConcurrent && this.pendingQueue.length > 0) {
      const taskId = this.pendingQueue.shift();
      if (!taskId) break;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "pending") {
        continue;
      }
      this.runningCount += 1;
      task.status = "running";
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
          id: `${taskId}:${crypto.randomUUID()}`,
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
      const runId = `local:task:${crypto.randomUUID()}`;
      const context = await this.opts.fetchAgentContext({
        conversationId: task.conversationId,
        agentType: task.agentType,
        runId,
        threadId: task.threadId,
      });

      if (task.systemPromptOverride) {
        context.systemPrompt = task.systemPromptOverride;
      }

      const result = await this.opts.runSubagent({
        conversationId: task.conversationId,
        userMessageId: runId,
        agentType: task.agentType,
        ...(task.cloudTaskId ? { taskId: task.cloudTaskId } : {}),
        taskDescription: task.description,
        taskPrompt: task.prompt,
        agentContext: context,
        persistToConvex: task.storageMode === "cloud",
        enableRemoteTools: true,
        abortSignal: task.controller.signal,
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
        toolExecutor: async (toolName, toolArgs, toolContext) => {
          const lockKey = getFsLockKey(toolName, toolArgs);
          if (!lockKey) {
            return await this.opts.toolExecutor(toolName, toolArgs, toolContext);
          }
          const release = await this.acquireFsLock(task.id, lockKey);
          try {
            return await this.opts.toolExecutor(toolName, toolArgs, toolContext);
          } finally {
            release();
          }
        },
      });

      task.completedAt = Date.now();
      if (task.controller.signal.aborted || task.status === "canceled") {
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
      if (task.controller.signal.aborted) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else {
        task.status = "error";
        task.error = (error as Error).message ?? "Task failed";
      }
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

  async createTask(request: TaskToolRequest): Promise<{ taskId: string }> {
    const id = `local:task:${crypto.randomUUID()}`;
    const controller = new AbortController();

    const task: RuntimeTaskRecord = {
      id,
      conversationId: request.conversationId,
      description: request.description,
      prompt: request.prompt,
      agentType: request.agentType,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller,
      storageMode: request.storageMode,
      parentTaskId: request.parentTaskId,
      threadId: request.threadId,
      threadName: request.threadName,
      commandId: request.commandId,
      systemPromptOverride: request.systemPromptOverride,
      recentActivity: [],
      progressBuffer: "",
    };

    this.tasks.set(task.id, task);
    this.pendingQueue.push(task.id);

    // Create cloud record in background (non-blocking)
    // Store the promise so completion can await it before syncing status.
    if (request.storageMode === "cloud") {
      const cloudParentTaskId =
        request.parentTaskId && !request.parentTaskId.startsWith("local:")
          ? request.parentTaskId
          : undefined;
      task.cloudCreatePromise = this.opts.createCloudTaskRecord({
        conversationId: request.conversationId,
        description: request.description,
        prompt: request.prompt,
        agentType: request.agentType,
        parentTaskId: cloudParentTaskId,
        commandId: request.commandId,
      }).then((created) => {
        task.cloudTaskId = created.taskId;
      }).catch(() => {
        // Cloud record creation failed — task runs locally only
      });
    }

    this.tryStartNext();
    return { taskId: task.id };
  }

  async getTask(taskId: string): Promise<TaskToolSnapshot | null> {
    const local = this.tasks.get(taskId);
    if (local) {
      return {
        id: local.id,
        description: local.description,
        status: local.status === "pending" ? "running" : local.status,
        startedAt: local.startedAt,
        completedAt: local.completedAt,
        result: local.result,
        error: local.error,
        recentActivity: local.status === "running" ? local.recentActivity : undefined,
      };
    }
    if (!taskId.startsWith("local:task:")) {
      return await this.opts.getCloudTaskRecord(taskId);
    }
    return null;
  }

  async cancelTask(taskId: string, reason?: string): Promise<{ canceled: boolean }> {
    const local = this.tasks.get(taskId);
    if (local) {
      if (local.status === "completed" || local.status === "error" || local.status === "canceled") {
        return { canceled: true };
      }
      local.error = reason ?? "Canceled";
      local.status = "canceled";
      local.completedAt = Date.now();
      local.controller.abort(new Error(local.error));
      if (local.storageMode === "cloud" && local.cloudTaskId) {
        await this.opts.cancelCloudTaskRecord(local.cloudTaskId, local.error);
      }
      return { canceled: true };
    }
    if (!taskId.startsWith("local:task:")) {
      return await this.opts.cancelCloudTaskRecord(taskId, reason);
    }
    return { canceled: false };
  }
}
