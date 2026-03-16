import crypto from "crypto";
import { createRuntimeLogger } from "../debug.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import { AGENT_IDS } from "../../../../src/shared/contracts/agent-runtime.js";
import type {
  RunnerContext,
  AgentCallbacks,
  AgentHealth,
  ChatPayload,
  QueuedOrchestratorTurn,
} from "./types.js";
import { sanitizeStellaBase } from "./shared.js";
import { createOrchestratorCoordinator } from "./orchestrator-coordinator.js";
import {
  launchPreparedOrchestratorRun,
  prepareOrchestratorRun,
} from "./orchestrator-launch.js";
import {
  canResolveRunnerLlmRoute,
} from "./model-selection.js";

const logger = createRuntimeLogger("runner.orchestrator");

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
  const coordinator = createOrchestratorCoordinator(context);
  const {
    cleanupRun,
    clearActiveOrchestratorRun,
    createRuntimeCallbacks,
    queueOrchestratorTurn,
    requestActiveOrchestratorCheckpoint,
    finishInterruptedRun,
  } = coordinator;

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

    const prepared = await prepareOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      replayTurn: payload.requeueOnInterrupt ? payload : null,
    });
    const runtimeCallbacks = createRuntimeCallbacks(runId, callbacks, {
      onInterrupted: prepared.replayInterruptedTurn,
    });

    launchPreparedOrchestratorRun({
      context,
      prepared,
      userMessageId: startArgs.userMessageId,
      runtimeCallbacks,
      webSearch: deps.webSearch,
      finishInterruptedRun,
      cleanupRun,
      onFatalError: (error) => {
        callbacks.onError({
          runId,
          agentType,
          seq: Date.now(),
          error: (error as Error).message || "Stella runtime failed",
          fatal: true,
        });
      },
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
      AGENT_IDS.ORCHESTRATOR,
      deps.resolveAgent(AGENT_IDS.ORCHESTRATOR),
    );
    if (canResolveRunnerLlmRoute(context, orchestratorModel)) {
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
    const agentType = payload.agentType ?? AGENT_IDS.ORCHESTRATOR;
    const userPrompt = payload.userPrompt.trim();
    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    const prepared = await prepareOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
    });

    logger.debug("handleLocalChat", {
      runId,
      agentType,
      model: prepared.agentContext.model,
      resolvedModel: prepared.resolvedLlm.model.id,
      conversationId,
      tools: prepared.agentContext.toolsAllowlist ?? [],
      threadHistoryCount: prepared.agentContext.threadHistory?.length ?? 0,
    });

    const runtimeCallbacks = createRuntimeCallbacks(runId, callbacks);

    launchPreparedOrchestratorRun({
      context,
      prepared,
      userMessageId: payload.userMessageId,
      runtimeCallbacks,
      webSearch: deps.webSearch,
      finishInterruptedRun,
      cleanupRun,
      onFatalError: (error) => {
        callbacks.onError({
          runId,
          agentType,
          seq: Date.now(),
          error: (error as Error).message || "Stella runtime failed",
          fatal: true,
        });
      },
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
    const agentType = payload.agentType ?? AGENT_IDS.ORCHESTRATOR;
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
    const prepared = await prepareOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      replayTurn: queuedTurn.requeueOnInterrupt ? queuedTurn : null,
    });

    const runtimeCallbacks = createRuntimeCallbacks(
      runId,
      {
        onStream: () => {},
        onToolStart: () => {},
        onToolEnd: () => {},
        onError: (event) => {
          resolveResult({
            status: "error",
            finalText: "",
            error: event.error || "Stella runtime failed",
          });
        },
        onEnd: (event) => {
          resolveResult({
            status: "ok",
            finalText: event.finalText,
          });
        },
      },
      {
        onInterrupted: prepared.replayInterruptedTurn,
      },
    );

    launchPreparedOrchestratorRun({
      context,
      prepared,
      userMessageId: `automation:${crypto.randomUUID()}`,
      runtimeCallbacks,
      webSearch: deps.webSearch,
      finishInterruptedRun,
      cleanupRun,
      onFatalError: (error) => {
        resolveResult({
          status: "error",
          finalText: "",
          error: (error as Error).message || "Stella runtime failed",
        });
      },
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
