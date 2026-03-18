import crypto from "crypto";
import { resolveLlmRoute } from "../model-routing.js";
import { getMaxAgentConcurrency } from "../preferences/local-preferences.js";
import { runSubagentTask, shutdownSubagentRuntimes } from "../agent-runtime.js";
import { LocalTaskManager } from "../tasks/local-task-manager.js";
import type { TaskToolRequest } from "../tools/types.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import {
  AGENT_IDS,
  isLocalCliAgentId,
  shouldControlSelfModHmr,
} from "../../../../src/shared/contracts/agent-runtime.js";
import type {
  AgentCallbacks,
  RunnerContext,
  QueuedOrchestratorTurn,
} from "./types.js";
import { buildTaskEventPrompt, createSelfModHmrState } from "./shared.js";
import type { SelfModHmrState } from "../../../../src/shared/contracts/electron-data.js";

export const createTaskOrchestration = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
    }) => Promise<LocalTaskManagerAgentContext>;
    queueOrchestratorTurn: (turn: QueuedOrchestratorTurn) => void;
    startStreamingOrchestratorTurn: (
      payload: QueuedOrchestratorTurn,
      startArgs: {
        conversationId: string;
        userPrompt: string;
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
    resolveTaskThread: ({ conversationId, agentType, threadName }) => {
      if (!isLocalCliAgentId(agentType)) {
        return null;
      }
      return context.runtimeStore.resolveOrCreateActiveThread({
        conversationId,
        agentType,
        threadName,
      });
    },
    onTaskEvent: (event) => {
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
          await deps.startStreamingOrchestratorTurn(
            queuedTurn,
            {
              conversationId: event.conversationId,
              userPrompt,
              agentType: AGENT_IDS.ORCHESTRATOR,
              userMessageId: `system:${crypto.randomUUID()}`,
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
      const shouldControlHmr = shouldControlSelfModHmr(agentType);
      const pauseApplied =
        shouldControlHmr && context.selfModHmrController
          ? await context.selfModHmrController.pause(runId)
          : true;

      if (shouldControlHmr && !pauseApplied) {
        console.warn(
          "[self-mod-hmr] Pause endpoint unavailable for self_mod subagent.",
        );
      }

      const resolvedLlm = resolveLlmRoute({
        stellaHomePath: context.stellaHomePath,
        modelName: agentContext.model,
        agentType,
        proxy: {
          baseUrl: context.state.proxyBaseUrl,
          getAuthToken: () => context.state.authToken?.trim(),
        },
      });
      const taskCallbacks =
        context.state.conversationCallbacks.get(conversationId) ?? null;
      const reportSelfModHmrState = (state: SelfModHmrState) => {
        taskCallbacks?.onSelfModHmrState?.(state);
      };
      if (shouldControlHmr && pauseApplied) {
        reportSelfModHmrState(createSelfModHmrState("paused", true));
      }
      if (shouldControlHmr && context.selfModLifecycle) {
        await Promise.resolve(
          context.selfModLifecycle.beginRun({
            runId,
            taskDescription,
            taskPrompt,
            conversationId,
            ...(selfModMetadata ?? {}),
          }),
        );
      }
      let subagentSucceeded = false;
      try {
        const result = await runSubagentTask({
          conversationId,
          userMessageId,
          runId,
          rootRunId,
          agentType,
          userPrompt: `${taskDescription}\n\n${taskPrompt}`,
          agentContext,
          toolExecutor,
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
        if (shouldControlHmr && context.selfModLifecycle) {
          if (subagentSucceeded) {
            await Promise.resolve(
              context.selfModLifecycle.finalizeRun({
                runId,
                taskDescription,
                taskPrompt,
                conversationId,
                succeeded: true,
                ...(selfModMetadata ?? {}),
              }),
            );
          } else if (typeof context.selfModLifecycle.cancelRun === "function") {
            await Promise.resolve(context.selfModLifecycle.cancelRun(runId));
          }
        }
        if (shouldControlHmr && context.selfModHmrController) {
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
                "[self-mod-hmr] Resume endpoint unavailable for self_mod subagent.",
              );
            }
          };

          try {
            const morphOrchestrator =
              context.getHmrMorphOrchestrator?.() ?? null;
            if (shouldMorph && taskCallbacks?.onHmrResume) {
              await taskCallbacks.onHmrResume({
                resumeHmr,
                reportState: reportSelfModHmrState,
                requiresFullReload,
              });
            } else if (shouldMorph && morphOrchestrator) {
              await morphOrchestrator.runTransition({
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
              "[self-mod-hmr] Failed to resume self_mod subagent HMR:",
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
      taskId: `local:task:${crypto.randomUUID()}`,
    }),
    completeCloudTaskRecord: async () => {},
    getCloudTaskRecord: async () => null,
    cancelCloudTaskRecord: async () => ({ canceled: false }),
  });

  const runBlockingLocalTask = async (
    request: Omit<TaskToolRequest, "storageMode">,
  ): Promise<
    | { status: "ok"; finalText: string; taskId: string }
    | { status: "error"; finalText: ""; error: string; taskId?: string }
  > => {
    if (!context.state.localTaskManager) {
      return {
        status: "error",
        finalText: "",
        error: "Task manager is unavailable.",
      };
    }
    const { taskId } = await context.state.localTaskManager.createTask({
      ...request,
      storageMode: "local",
    });
    while (true) {
      const snapshot = await context.state.localTaskManager.getTask(taskId);
      if (!snapshot) {
        return {
          status: "error",
          finalText: "",
          error: "Task record disappeared before completion.",
          taskId,
        };
      }
      if (snapshot.status === "completed") {
        return {
          status: "ok",
          finalText: snapshot.result ?? "",
          taskId,
        };
      }
      if (snapshot.status === "error" || snapshot.status === "canceled") {
        return {
          status: "error",
          finalText: "",
          error: snapshot.error ?? "Task failed",
          taskId,
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  };

  const createBackgroundTask = async (
    request: Omit<TaskToolRequest, "storageMode">,
  ): Promise<void> => {
    if (!context.state.localTaskManager) {
      throw new Error("Task manager is unavailable.");
    }
    await context.state.localTaskManager.createTask({
      ...request,
      storageMode: "local",
    });
  };

  const shutdown = () => {
    shutdownSubagentRuntimes();
  };

  return {
    runBlockingLocalTask,
    createBackgroundTask,
    shutdown,
  };
};
