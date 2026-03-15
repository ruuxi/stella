import crypto from "crypto";
import { canResolveLlmRoute, resolveLlmRoute } from "../model-routing.js";
import {
  runOrchestratorTurn,
  type RuntimeRunCallbacks,
} from "../agent-runtime.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type {
  RunnerContext,
  AgentCallbacks,
  AgentHealth,
  ChatPayload,
  QueuedOrchestratorTurn,
} from "./types.js";
import { QUEUED_TURN_INTERRUPT_ERROR, sanitizeStellaBase } from "./shared.js";

export const createOrchestratorController = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
    }) => Promise<LocalTaskManagerAgentContext>;
    resolveAgent: (agentType: string) => unknown;
    getConfiguredModel: (
      agentType: string,
      agent?: unknown,
    ) => string | undefined;
    webSearch: (
      query: string,
      options?: { category?: string; displayResults?: boolean },
    ) => Promise<{
      text: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }>;
  },
) => {
  const clearActiveOrchestratorRun = (runId: string) => {
    if (context.state.activeOrchestratorRunId !== runId) {
      return;
    }
    context.state.activeOrchestratorRunId = null;
    context.state.activeOrchestratorConversationId = null;
    context.state.activeToolExecutionCount = 0;
    context.state.interruptAfterTool = false;
    context.state.activeInterruptedReplayTurn = null;
  };

  const abortActiveOrchestratorRunForQueuedTurn = () => {
    if (!context.state.activeOrchestratorRunId) {
      return false;
    }
    const runId = context.state.activeOrchestratorRunId;
    const abortController =
      context.state.activeRunAbortControllers.get(runId) ?? null;
    if (!abortController || context.state.interruptedRunIds.has(runId)) {
      return false;
    }
    context.state.interruptedRunIds.add(runId);
    abortController.abort(new Error(QUEUED_TURN_INTERRUPT_ERROR));
    return true;
  };

  const requestActiveOrchestratorCheckpoint = () => {
    if (!context.state.activeOrchestratorRunId) {
      return false;
    }
    if (context.state.activeToolExecutionCount > 0) {
      context.state.interruptAfterTool = true;
      return true;
    }
    context.state.interruptAfterTool = false;
    return abortActiveOrchestratorRunForQueuedTurn();
  };

  const maybeInterruptAfterToolCheckpoint = () => {
    if (
      !context.state.interruptAfterTool ||
      context.state.activeToolExecutionCount > 0
    ) {
      return;
    }
    context.state.interruptAfterTool = false;
    abortActiveOrchestratorRunForQueuedTurn();
  };

  const drainQueuedOrchestratorTurns = async (): Promise<void> => {
    if (context.state.activeOrchestratorRunId) {
      return;
    }

    while (
      !context.state.activeOrchestratorRunId &&
      context.state.queuedOrchestratorTurns.length > 0
    ) {
      const nextTurn = context.state.queuedOrchestratorTurns.shift();
      if (!nextTurn) {
        return;
      }
      try {
        await nextTurn.execute();
      } catch {
        // Individual queued turn handlers notify callers.
      }
    }
  };

  const queueOrchestratorTurn = (turn: QueuedOrchestratorTurn) => {
    if (turn.priority === "user") {
      const firstSystemIndex = context.state.queuedOrchestratorTurns.findIndex(
        (entry) => entry.priority !== "user",
      );
      if (firstSystemIndex === -1) {
        context.state.queuedOrchestratorTurns.push(turn);
      } else {
        context.state.queuedOrchestratorTurns.splice(firstSystemIndex, 0, turn);
      }
    } else {
      context.state.queuedOrchestratorTurns.push(turn);
    }
    if (context.state.activeOrchestratorRunId) {
      requestActiveOrchestratorCheckpoint();
      return;
    }
    queueMicrotask(() => {
      void drainQueuedOrchestratorTurns();
    });
  };

  const createRuntimeCallbacks = (
    runId: string,
    callbacks: AgentCallbacks,
    options?: {
      onInterrupted?: () => void;
      onCleanup?: () => void;
    },
  ): RuntimeRunCallbacks => {
    const cleanupRun = () => {
      context.state.activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      options?.onCleanup?.();
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
    };

    return {
      onStream: callbacks.onStream,
      onToolStart: (event) => {
        context.state.activeToolExecutionCount += 1;
        callbacks.onToolStart(event);
      },
      onToolEnd: (event) => {
        context.state.activeToolExecutionCount = Math.max(
          0,
          context.state.activeToolExecutionCount - 1,
        );
        callbacks.onToolEnd(event);
        if (context.state.activeOrchestratorRunId === runId) {
          maybeInterruptAfterToolCheckpoint();
        }
      },
      onError: (event) => {
        if (context.state.interruptedRunIds.delete(runId)) {
          cleanupRun();
          options?.onInterrupted?.();
          return;
        }
        callbacks.onError(event);
        if (event.fatal) {
          cleanupRun();
        }
      },
      onEnd: (event) => {
        if (context.state.interruptedRunIds.delete(runId)) {
          cleanupRun();
          options?.onInterrupted?.();
          return;
        }
        cleanupRun();
        callbacks.onEnd(event);
      },
    };
  };

  const startStreamingOrchestratorTurn = async (
    payload: QueuedOrchestratorTurn,
    startArgs: {
      conversationId: string;
      userPrompt: string;
      agentType: string;
      userMessageId: string;
    },
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running.");
    }

    const runId = `local:${crypto.randomUUID()}`;
    const conversationId = startArgs.conversationId;
    const agentType = startArgs.agentType;
    const userPrompt = startArgs.userPrompt.trim();
    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    const agentContext = await deps.buildAgentContext({
      conversationId,
      agentType,
      runId,
    });
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: context.StellaHome,
      modelName: agentContext.model,
      agentType,
      proxy: {
        baseUrl: context.state.proxyBaseUrl,
        getAuthToken: () => context.state.authToken?.trim(),
      },
    });

    context.state.activeOrchestratorRunId = runId;
    context.state.activeOrchestratorConversationId = conversationId;
    context.state.activeInterruptedReplayTurn = payload.requeueOnInterrupt
      ? payload
      : null;

    const abortController = new AbortController();
    context.state.activeRunAbortControllers.set(runId, abortController);
    const replayInterruptedTurn = () => {
      const replayTurn = context.state.activeInterruptedReplayTurn;
      if (replayTurn) {
        queueOrchestratorTurn(replayTurn);
      }
    };

    const runtimeCallbacks = createRuntimeCallbacks(runId, callbacks, {
      onInterrupted: replayInterruptedTurn,
    });

    void runOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: startArgs.userMessageId,
      agentType,
      userPrompt,
      agentContext,
      callbacks: runtimeCallbacks,
      toolExecutor: (toolName, args, toolContext) =>
        context.toolHost.executeTool(toolName, args, toolContext),
      deviceId: context.deviceId,
      stellaHome: context.StellaHome,
      resolvedLlm,
      store: context.runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot: context.frontendRoot,
      selfModMonitor: context.selfModMonitor,
      webSearch: deps.webSearch,
      hookEmitter: context.hookEmitter,
      displayHtml: context.displayHtml,
    }).catch((error) => {
      if (context.state.interruptedRunIds.delete(runId)) {
        context.state.activeRunAbortControllers.delete(runId);
        clearActiveOrchestratorRun(runId);
        replayInterruptedTurn();
        queueMicrotask(() => {
          void drainQueuedOrchestratorTurns();
        });
        return;
      }
      context.state.activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
      callbacks.onError({
        runId,
        agentType,
        seq: Date.now(),
        error: (error as Error).message || "Stella runtime failed",
        fatal: true,
      });
    });

    return { runId };
  };

  const agentHealthCheck = (): AgentHealth => {
    if (!context.state.isRunning) {
      return {
        ready: false,
        reason: "Stella runtime is not started",
        engine: "stella",
      };
    }
    if (!context.state.isInitialized) {
      return {
        ready: false,
        reason: "Stella runtime is still initializing",
        engine: "stella",
      };
    }
    const orchestratorModel = deps.getConfiguredModel(
      "orchestrator",
      deps.resolveAgent("orchestrator"),
    );
    if (
      canResolveLlmRoute({
        stellaHomePath: context.StellaHome,
        modelName: orchestratorModel,
        proxy: {
          baseUrl: context.state.proxyBaseUrl,
          getAuthToken: () => context.state.authToken?.trim(),
        },
      })
    ) {
      return { ready: true, engine: "pi" };
    }
    const hasProxyUrl = Boolean(sanitizeStellaBase(context.state.proxyBaseUrl));
    const hasAuthToken = Boolean(context.state.authToken?.trim());
    if (!hasProxyUrl) {
      return { ready: false, reason: "Missing proxy URL", engine: "pi" };
    }
    if (!hasAuthToken) {
      return { ready: false, reason: "Missing auth token", engine: "pi" };
    }
    return { ready: false, reason: "No usable model route", engine: "pi" };
  };

  const startLocalChatTurn = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error(
        "The orchestrator is already running. Wait for it to finish before starting another run.",
      );
    }

    const conversationId = payload.conversationId;
    const runId = `local:${crypto.randomUUID()}`;
    const agentType = payload.agentType ?? "orchestrator";
    const userPrompt = payload.userPrompt.trim();
    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    const agentContext = await deps.buildAgentContext({
      conversationId,
      agentType,
      runId,
    });
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: context.StellaHome,
      modelName: agentContext.model,
      agentType,
      proxy: {
        baseUrl: context.state.proxyBaseUrl,
        getAuthToken: () => context.state.authToken?.trim(),
      },
    });

    console.log(
      `[stella:trace] handleLocalChat | runId=${runId} | agent=${agentType} | model=${agentContext.model} | resolvedModel=${resolvedLlm.model.id} | convId=${conversationId}`,
    );
    console.log(
      `[stella:trace] handleLocalChat | tools=[${(agentContext.toolsAllowlist ?? []).join(", ")}]`,
    );
    console.log(
      `[stella:trace] handleLocalChat | threadHistory=${agentContext.threadHistory?.length ?? 0} messages`,
    );

    context.state.activeOrchestratorRunId = runId;
    context.state.activeOrchestratorConversationId = conversationId;

    const abortController = new AbortController();
    context.state.activeRunAbortControllers.set(runId, abortController);

    const runtimeCallbacks = createRuntimeCallbacks(runId, callbacks);

    void runOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: payload.userMessageId,
      agentType,
      userPrompt,
      agentContext,
      callbacks: runtimeCallbacks,
      toolExecutor: (toolName, args, toolContext) =>
        context.toolHost.executeTool(toolName, args, toolContext),
      deviceId: context.deviceId,
      stellaHome: context.StellaHome,
      resolvedLlm,
      store: context.runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot: context.frontendRoot,
      selfModMonitor: context.selfModMonitor,
      webSearch: deps.webSearch,
      hookEmitter: context.hookEmitter,
      displayHtml: context.displayHtml,
    }).catch((error) => {
      if (context.state.interruptedRunIds.delete(runId)) {
        context.state.activeRunAbortControllers.delete(runId);
        clearActiveOrchestratorRun(runId);
        queueMicrotask(() => {
          void drainQueuedOrchestratorTurns();
        });
        return;
      }
      context.state.activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
      callbacks.onError({
        runId,
        agentType,
        seq: Date.now(),
        error: (error as Error).message || "Stella runtime failed",
        fatal: true,
      });
    });

    return { runId };
  };

  const handleLocalChat = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    context.state.conversationCallbacks.set(payload.conversationId, callbacks);

    const queuedTurn: QueuedOrchestratorTurn = {
      priority: "user",
      requeueOnInterrupt: false,
      execute: async () => {
        await startLocalChatTurn(payload, callbacks);
      },
    };

    if (context.state.activeOrchestratorRunId) {
      return await new Promise<{ runId: string }>((resolve, reject) => {
        queueOrchestratorTurn({
          ...queuedTurn,
          execute: async () => {
            try {
              resolve(await startLocalChatTurn(payload, callbacks));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        });
      });
    }

    return await startLocalChatTurn(payload, callbacks);
  };

  const startAutomationTurn = async (
    queuedTurn: QueuedOrchestratorTurn,
    payload: {
      conversationId: string;
      userPrompt: string;
      agentType?: string;
    },
    resolveResult: (
      value:
        | { status: "ok"; finalText: string }
        | { status: "busy"; finalText: ""; error: string }
        | { status: "error"; finalText: ""; error: string },
    ) => void,
  ): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running.");
    }

    const conversationId = payload.conversationId.trim();
    const userPrompt = payload.userPrompt.trim();
    const agentType = payload.agentType ?? "orchestrator";
    if (!conversationId) {
      resolveResult({
        status: "error",
        finalText: "",
        error: "Missing conversationId",
      });
      return { runId: "" };
    }
    if (!userPrompt) {
      resolveResult({
        status: "error",
        finalText: "",
        error: "Missing user prompt",
      });
      return { runId: "" };
    }

    const runId = `local:auto:${crypto.randomUUID()}`;
    const agentContext = await deps.buildAgentContext({
      conversationId,
      agentType,
      runId,
    });
    const resolvedLlm = resolveLlmRoute({
      stellaHomePath: context.StellaHome,
      modelName: agentContext.model,
      agentType,
      proxy: {
        baseUrl: context.state.proxyBaseUrl,
        getAuthToken: () => context.state.authToken?.trim(),
      },
    });

    context.state.activeOrchestratorRunId = runId;
    context.state.activeOrchestratorConversationId = conversationId;
    context.state.activeInterruptedReplayTurn = queuedTurn.requeueOnInterrupt
      ? queuedTurn
      : null;

    const abortController = new AbortController();
    context.state.activeRunAbortControllers.set(runId, abortController);
    const replayInterruptedTurn = () => {
      const replayTurn = context.state.activeInterruptedReplayTurn;
      if (replayTurn) {
        queueOrchestratorTurn(replayTurn);
      }
    };

    void runOrchestratorTurn({
      runId,
      conversationId,
      userMessageId: `automation:${crypto.randomUUID()}`,
      agentType,
      userPrompt,
      agentContext,
      callbacks: {
        onStream: () => {},
        onToolStart: () => {
          context.state.activeToolExecutionCount += 1;
        },
        onToolEnd: () => {
          context.state.activeToolExecutionCount = Math.max(
            0,
            context.state.activeToolExecutionCount - 1,
          );
          if (context.state.activeOrchestratorRunId === runId) {
            maybeInterruptAfterToolCheckpoint();
          }
        },
        onError: (event) => {
          if (context.state.interruptedRunIds.delete(runId)) {
            context.state.activeRunAbortControllers.delete(runId);
            clearActiveOrchestratorRun(runId);
            replayInterruptedTurn();
            queueMicrotask(() => {
              void drainQueuedOrchestratorTurns();
            });
            return;
          }
          context.state.activeRunAbortControllers.delete(runId);
          clearActiveOrchestratorRun(runId);
          queueMicrotask(() => {
            void drainQueuedOrchestratorTurns();
          });
          resolveResult({
            status: "error",
            finalText: "",
            error: event.error || "Stella runtime failed",
          });
        },
        onEnd: (event) => {
          if (context.state.interruptedRunIds.delete(runId)) {
            context.state.activeRunAbortControllers.delete(runId);
            clearActiveOrchestratorRun(runId);
            replayInterruptedTurn();
            queueMicrotask(() => {
              void drainQueuedOrchestratorTurns();
            });
            return;
          }
          context.state.activeRunAbortControllers.delete(runId);
          clearActiveOrchestratorRun(runId);
          queueMicrotask(() => {
            void drainQueuedOrchestratorTurns();
          });
          resolveResult({
            status: "ok",
            finalText: event.finalText,
          });
        },
      },
      toolExecutor: (toolName, args, toolContext) =>
        context.toolHost.executeTool(toolName, args, toolContext),
      deviceId: context.deviceId,
      stellaHome: context.StellaHome,
      resolvedLlm,
      store: context.runtimeStore,
      abortSignal: abortController.signal,
      frontendRoot: context.frontendRoot,
      selfModMonitor: context.selfModMonitor,
      webSearch: deps.webSearch,
      hookEmitter: context.hookEmitter,
      displayHtml: context.displayHtml,
    }).catch((error) => {
      if (context.state.interruptedRunIds.delete(runId)) {
        context.state.activeRunAbortControllers.delete(runId);
        clearActiveOrchestratorRun(runId);
        replayInterruptedTurn();
        queueMicrotask(() => {
          void drainQueuedOrchestratorTurns();
        });
        return;
      }
      context.state.activeRunAbortControllers.delete(runId);
      clearActiveOrchestratorRun(runId);
      queueMicrotask(() => {
        void drainQueuedOrchestratorTurns();
      });
      resolveResult({
        status: "error",
        finalText: "",
        error: (error as Error).message || "Stella runtime failed",
      });
    });

    return { runId };
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
  }): Promise<
    | { status: "ok"; finalText: string }
    | { status: "busy"; finalText: ""; error: string }
    | { status: "error"; finalText: ""; error: string }
  > => {
    const health = agentHealthCheck();
    if (!health.ready) {
      return {
        status: "error",
        finalText: "",
        error: health.reason ?? "Stella runtime not ready",
      };
    }

    return await new Promise<
      | { status: "ok"; finalText: string }
      | { status: "busy"; finalText: ""; error: string }
      | { status: "error"; finalText: ""; error: string }
    >((resolve) => {
      const queuedTurn: QueuedOrchestratorTurn = {
        priority: "system",
        requeueOnInterrupt: true,
        execute: async () => {
          await startAutomationTurn(queuedTurn, payload, resolve);
        },
      };

      if (context.state.activeOrchestratorRunId) {
        queueOrchestratorTurn(queuedTurn);
        return;
      }

      void queuedTurn.execute();
    });
  };

  const cancelLocalChat = (runId: string) => {
    const controller = context.state.activeRunAbortControllers.get(runId);
    if (!controller) return;
    controller.abort();
    context.state.activeRunAbortControllers.delete(runId);
    clearActiveOrchestratorRun(runId);
  };

  const getActiveOrchestratorRun = (): {
    runId: string;
    conversationId: string;
  } | null => {
    if (
      !context.state.activeOrchestratorRunId ||
      !context.state.activeOrchestratorConversationId
    ) {
      return null;
    }
    return {
      runId: context.state.activeOrchestratorRunId,
      conversationId: context.state.activeOrchestratorConversationId,
    };
  };

  return {
    agentHealthCheck,
    queueOrchestratorTurn,
    startStreamingOrchestratorTurn,
    handleLocalChat,
    runAutomationTurn,
    cancelLocalChat,
    getActiveOrchestratorRun,
  };
};
