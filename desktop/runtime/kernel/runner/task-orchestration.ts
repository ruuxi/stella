import crypto from "crypto";
import path from "path";
import { resolveLlmRoute } from "../model-routing.js";
import { getMaxAgentConcurrency } from "../preferences/local-preferences.js";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { LocalTaskManager } from "../tasks/local-task-manager.js";
import type { TaskToolRequest, ToolContext, ToolResult } from "../tools/types.js";
import type {
  LocalTaskManagerAgentContext,
  TaskLifecycleEvent,
} from "../tasks/local-task-manager.js";
import { GENERAL_STARTER_TOOLS } from "../agents/core-agent-prompts.js";
import {
  AGENT_IDS,
  isLocalCliAgentId,
} from "../../../src/shared/contracts/agent-runtime.js";
import type {
  AgentCallbacks,
  RunnerContext,
  QueuedOrchestratorTurn,
} from "./types.js";
import { buildTaskEventPrompt, createSelfModHmrState } from "./shared.js";
import type { SelfModHmrState } from "../../contracts/index.js";

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const SHELL_PATH_SOURCE = String.raw`(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])`;
const SHELL_REDIRECT_PATTERN = new RegExp(
  String.raw`(?:^|[;&|]\s*|\s)\d*>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s"'` +
    "`" +
    String.raw`]+))`,
);
const SHELL_PATH_PATTERN = new RegExp(
  String.raw`(?:^|\s)(?:"(${SHELL_PATH_SOURCE}[^"]+)"|'(${SHELL_PATH_SOURCE}[^']+)'|(${SHELL_PATH_SOURCE}[^\s"'` +
    "`" +
    String.raw`]+))`,
);

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const shortHash = (value: string): string =>
  crypto
    .createHash("sha1")
    .update(value)
    .digest("hex")
    .slice(0, 10);

const deriveConversationFeatureId = (conversationId: string): string => {
  const normalizedConversationId = normalizeString(conversationId);
  if (!normalizedConversationId) {
    return `feature-${shortHash(crypto.randomUUID())}`;
  }
  return `feature-${shortHash(normalizedConversationId)}`;
};

const resolveSelfModMetadata = (args: {
  conversationId: string;
  agentType: string;
  selfModMetadata?: TaskToolRequest["selfModMetadata"];
}): TaskToolRequest["selfModMetadata"] | undefined => {
  if (args.selfModMetadata) {
    return {
      ...args.selfModMetadata,
      mode: args.selfModMetadata.mode ?? "author",
    };
  }
  if (args.agentType !== AGENT_IDS.GENERAL) {
    return undefined;
  }
  return {
    featureId: deriveConversationFeatureId(args.conversationId),
    mode: "author",
  };
};

const getPathApi = (...values: Array<string | undefined>) =>
  values.some((value) => value && WINDOWS_PATH_PATTERN.test(value))
    ? path.win32
    : path.posix;

const pickMatch = (value: string, pattern: RegExp): string | undefined =>
  value.match(pattern)?.slice(1).find((part): part is string => Boolean(part));

const extractShellPath = (command: string): string | undefined =>
  pickMatch(command, SHELL_REDIRECT_PATTERN) ?? pickMatch(command, SHELL_PATH_PATTERN);

const resolvePath = (candidate: string, cwd?: string): string => {
  const pathApi = getPathApi(candidate, cwd);
  const base = normalizeString(cwd) ?? process.cwd();
  return pathApi.normalize(
    pathApi.isAbsolute(candidate)
      ? candidate
      : pathApi.resolve(base, candidate),
  );
};

export const resolveHmrToolTargetPath = (
  toolName: string,
  args: Record<string, unknown>,
  fallbackCwd?: string,
): string | null => {
  const workingDirectory =
    normalizeString(args.working_directory ?? args.cwd) ?? fallbackCwd;
  if (toolName === "Write" || toolName === "Edit") {
    const rawPath = normalizeString(
      args.file_path ?? args.path ?? args.target_path,
    );
    return rawPath ? resolvePath(rawPath, workingDirectory) : null;
  }
  if (toolName === "Bash") {
    const command = normalizeString(args.command);
    if (!command) return null;
    const rawPath = extractShellPath(command);
    return rawPath ? resolvePath(rawPath, workingDirectory) : null;
  }
  return null;
};

export const isHmrPathUnderDirectory = (
  filePath: string,
  directory: string,
): boolean => {
  const pathApi = getPathApi(filePath, directory);
  const normalizeForCompare = (value: string) =>
    pathApi === path.win32
      ? pathApi.normalize(value).toLowerCase()
      : pathApi.normalize(value);
  const relativePath = pathApi.relative(
    normalizeForCompare(directory),
    normalizeForCompare(filePath),
  );
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
  );
};

const appendTaskLifecycleChatEvent = (
  context: RunnerContext,
  event: TaskLifecycleEvent,
) => {
  if (!context.appendLocalChatEvent) {
    return;
  }

  if (event.type === "task-started") {
    context.appendLocalChatEvent({
      conversationId: event.conversationId,
      type: "task_started",
      payload: {
        taskId: event.taskId,
        description: event.description,
        agentType: event.agentType,
        ...(event.parentTaskId ? { parentTaskId: event.parentTaskId } : {}),
      },
    });
    return;
  }

  if (event.type === "task-completed") {
    context.appendLocalChatEvent({
      conversationId: event.conversationId,
      type: "task_completed",
      payload: {
        taskId: event.taskId,
        ...(event.result ? { result: event.result } : {}),
      },
    });
    return;
  }

  if (event.type === "task-failed") {
    context.appendLocalChatEvent({
      conversationId: event.conversationId,
      type: "task_failed",
      payload: {
        taskId: event.taskId,
        ...(event.error ? { error: event.error } : {}),
      },
    });
    return;
  }

  if (event.type === "task-canceled") {
    context.appendLocalChatEvent({
      conversationId: event.conversationId,
      type: "task_canceled",
      payload: {
        taskId: event.taskId,
        ...(event.error ? { error: event.error } : {}),
      },
    });
    return;
  }

  if (event.type === "task-progress") {
    context.appendLocalChatEvent({
      conversationId: event.conversationId,
      type: "task_progress",
      payload: {
        taskId: event.taskId,
        statusText: event.statusText,
      },
    });
  }
};

export const createTaskOrchestration = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
      selfModMetadata?: TaskToolRequest["selfModMetadata"];
    }) => Promise<LocalTaskManagerAgentContext>;
    queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
    startStreamingOrchestratorTurn: (
      payload: QueuedOrchestratorTurn,
      startArgs: {
        conversationId: string;
        userPrompt: string;
        promptMessages?: Array<{
          text: string;
          uiVisibility?: "visible" | "hidden";
        }>;
        agentType: string;
        userMessageId: string;
      },
      callbacks: AgentCallbacks,
    ) => Promise<{ runId: string }>;
    webSearch: (
      query: string,
      options?: { category?: string; displayResults?: boolean },
    ) => Promise<{
      text: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }>;
  },
) => {
  context.state.localTaskManager = new LocalTaskManager({
    maxConcurrent: 24,
    getMaxConcurrent: () => getMaxAgentConcurrency(context.stellaHomePath),
    getStarterTools: (agentType) =>
      agentType === AGENT_IDS.GENERAL ? [...GENERAL_STARTER_TOOLS] : [],
    resolveTaskThread: ({ conversationId, agentType, threadId }) => {
      if (!isLocalCliAgentId(agentType)) {
        return null;
      }
      return context.runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadId,
      });
    },
    onTaskEvent: (event) => {
      appendTaskLifecycleChatEvent(context, event);
      context.state.conversationCallbacks
        .get(event.conversationId)
        ?.onTaskEvent?.(event);
      const userPrompt = buildTaskEventPrompt(event);
      if (!userPrompt) {
        return;
      }
      const queuedTurn: QueuedOrchestratorTurn = {
        priority: "system",
        requeueOnInterrupt: true,
        execute: async () => {
          const callbacks = context.state.conversationCallbacks.get(
            event.conversationId,
          );
          if (!callbacks) {
            return;
          }
          const userMessageId = `system:${crypto.randomUUID()}`;
          await deps.startStreamingOrchestratorTurn(
            queuedTurn,
            {
              conversationId: event.conversationId,
              userPrompt: "",
              promptMessages: [{ text: userPrompt, uiVisibility: "hidden" }],
              agentType: AGENT_IDS.ORCHESTRATOR,
              userMessageId,
            },
            callbacks,
          );
        },
      };
      deps.queueOrchestratorTurn(queuedTurn);
    },
    fetchAgentContext: deps.buildAgentContext,
    runSubagent: async ({
      conversationId,
      userMessageId,
      agentType,
      taskId,
      rootRunId,
      agentContext,
      taskDescription,
      taskPrompt,
      abortSignal,
      selfModMetadata,
      onProgress,
      toolExecutor,
    }) => {
      const runId = `local:sub:${crypto.randomUUID()}`;
      const effectiveSelfModMetadata = resolveSelfModMetadata({
        conversationId,
        agentType,
        selfModMetadata,
      });
      const shouldAttachSelfModLifecycle =
        Boolean(effectiveSelfModMetadata) && Boolean(context.selfModLifecycle);

      const resolvedLlm = resolveLlmRoute({
        stellaHomePath: context.stellaHomePath,
        modelName: agentContext.model,
        agentType,
        site: {
          baseUrl: context.state.convexSiteUrl,
          getAuthToken: () => context.state.authToken?.trim(),
        },
      });
      const taskCallbacks =
        context.state.conversationCallbacks.get(conversationId) ?? null;
      const reportSelfModHmrState = (state: SelfModHmrState) => {
        taskCallbacks?.onSelfModHmrState?.(state);
      };

      let hmrPaused = false;
      const pauseHmrIfStellaWrite = async (
        toolName: string,
        args: Record<string, unknown>,
      ) => {
        if (hmrPaused || !context.selfModHmrController || !context.frontendRoot) return;
        const targetPath = resolveHmrToolTargetPath(
          toolName,
          args,
          context.frontendRoot,
        );
        if (!targetPath || !isHmrPathUnderDirectory(targetPath, context.frontendRoot)) return;
        hmrPaused = true;
        const applied = await context.selfModHmrController.pause(runId);
        if (!applied) {
          console.warn("[self-mod-hmr] Pause endpoint unavailable for Stella file write.");
        } else {
          reportSelfModHmrState(createSelfModHmrState("paused", true));
        }
      };

      const hmrAwareToolExecutor = async (
        toolName: string,
        args: Record<string, unknown>,
        ctx: ToolContext,
        signal?: AbortSignal,
      ): Promise<ToolResult> => {
        await pauseHmrIfStellaWrite(toolName, args);
        return toolExecutor(toolName, args, ctx, signal);
      };

      if (shouldAttachSelfModLifecycle) {
        await Promise.resolve(
          context.selfModLifecycle!.beginRun({
            runId,
            taskDescription,
            taskPrompt,
            conversationId,
            ...(effectiveSelfModMetadata ?? {}),
          }),
        );
      }
      let subagentSucceeded = false;
      try {
        const result = await runSubagentTask({
          conversationId,
          userMessageId,
          runId,
          taskId,
          rootRunId,
          agentType,
          userPrompt: `${taskDescription}\n\n${taskPrompt}`,
          selfModMetadata: effectiveSelfModMetadata,
          agentContext,
          toolCatalog: context.toolHost.getToolCatalog(),
          toolExecutor: hmrAwareToolExecutor,
          deviceId: context.deviceId,
          stellaHome: context.stellaHomePath,
          resolvedLlm,
          store: context.runtimeStore,
          abortSignal,
          frontendRoot: context.frontendRoot,
          selfModMonitor: context.selfModMonitor,
          onProgress,
          callbacks: taskCallbacks
            ? {
                onStream: (event) => taskCallbacks.onStream(event),
                onToolStart: (event) => taskCallbacks.onToolStart(event),
                onToolEnd: (event) => taskCallbacks.onToolEnd(event),
                onError: (event) => taskCallbacks.onError(event),
                onEnd: (event) => taskCallbacks.onEnd(event),
              }
            : undefined,
          webSearch: deps.webSearch,
          hookEmitter: context.hookEmitter,
        });
        subagentSucceeded = !result.error;
        return result;
      } finally {
        if (shouldAttachSelfModLifecycle) {
          if (subagentSucceeded) {
            await Promise.resolve(
              context.selfModLifecycle!.finalizeRun({
                runId,
                taskDescription,
                taskPrompt,
                conversationId,
                succeeded: true,
                ...(effectiveSelfModMetadata ?? {}),
              }),
            );
          } else if (typeof context.selfModLifecycle!.cancelRun === "function") {
            await Promise.resolve(context.selfModLifecycle!.cancelRun(runId));
          }
        }
        if (hmrPaused && context.selfModHmrController) {
          const status = await context.selfModHmrController
            .getStatus()
            .catch(() => null);
          const requiresFullReload = Boolean(status?.requiresFullReload);
          const shouldMorph = Boolean(
            status && (status.queuedFiles > 0 || status.requiresFullReload),
          );
          const resumeHmr = async () => {
            const resumeApplied =
              await context.selfModHmrController?.resume(runId);
            if (!resumeApplied) {
              console.warn(
                "[self-mod-hmr] Resume endpoint unavailable after Stella file write.",
              );
            }
          };

          try {
            const hmrTransitionController =
              context.getHmrTransitionController?.() ?? null;
            if (shouldMorph && taskCallbacks?.onHmrResume) {
              await taskCallbacks.onHmrResume({
                runId,
                resumeHmr,
                reportState: reportSelfModHmrState,
                requiresFullReload,
              });
            } else if (shouldMorph && hmrTransitionController) {
              await hmrTransitionController.runTransition({
                runId,
                resumeHmr,
                reportState: reportSelfModHmrState,
                requiresFullReload,
              });
            } else {
              reportSelfModHmrState(
                createSelfModHmrState(
                  requiresFullReload ? "reloading" : "applying",
                  false,
                  requiresFullReload,
                ),
              );
              await resumeHmr();
              reportSelfModHmrState(createSelfModHmrState("idle", false));
            }
          } catch (error) {
            console.warn(
              "[self-mod-hmr] Failed to resume HMR after Stella file write:",
              (error as Error).message,
            );
            await context.selfModHmrController
              .resume(runId)
              .catch(() => undefined);
            reportSelfModHmrState(createSelfModHmrState("idle", false));
          }
        }
      }
    },
    toolExecutor: (toolName, args, toolContext) =>
      context.toolHost.executeTool(toolName, args, toolContext),
    createCloudTaskRecord: async () => ({
      taskId: `cloud-stub-${crypto.randomUUID().slice(0, 8)}`,
    }),
    completeCloudTaskRecord: async () => {},
    getCloudTaskRecord: async () => null,
    cancelCloudTaskRecord: async () => ({ canceled: false }),
    saveTaskRecord: (record) => context.runtimeStore.saveTaskRecord?.(record),
    getTaskRecord: (threadId) => context.runtimeStore.getTaskRecord?.(threadId) ?? null,
  });

  const runBlockingLocalTask = async (
    request: Omit<TaskToolRequest, "storageMode">,
  ): Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  > => {
    if (!context.state.localTaskManager) {
      return {
        status: "error",
        finalText: "",
        error: "Task manager is unavailable.",
      };
    }
    const { threadId } = await context.state.localTaskManager.createTask({
      ...request,
      storageMode: "local",
    });
    while (true) {
      const snapshot = await context.state.localTaskManager.getTask(threadId);
      if (!snapshot) {
        return {
          status: "error",
          finalText: "",
          error: "Task record disappeared before completion.",
          threadId,
        };
      }
      if (snapshot.status === "completed") {
        return {
          status: "ok",
          finalText: snapshot.result ?? "",
          threadId,
        };
      }
      if (snapshot.status === "error" || snapshot.status === "canceled") {
        return {
          status: "error",
          finalText: "",
          error: snapshot.error ?? "Task failed",
          threadId,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  };

  const createBackgroundTask = async (
    request: Omit<TaskToolRequest, "storageMode">,
  ): Promise<{ threadId: string }> => {
    if (!context.state.localTaskManager) {
      throw new Error("Task manager is unavailable.");
    }
    const { threadId } = await context.state.localTaskManager.createTask({
      ...request,
      storageMode: "local",
    });
    return { threadId };
  };

  const shutdown = () => {
    context.state.localTaskManager?.shutdown();
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalTask,
    createBackgroundTask,
    shutdown,
  };
};
