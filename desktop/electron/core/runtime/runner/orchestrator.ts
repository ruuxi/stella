import crypto from "crypto";
import { createRuntimeLogger } from "../debug.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type {
  RunnerContext,
  AgentCallbacks,
  ChatPayload,
  QueuedOrchestratorTurn,
} from "./types.js";
import { createOrchestratorCoordinator } from "./orchestrator-coordinator.js";
import {
  executeOrQueueSystemOrchestratorTurn,
  executeOrQueueUserOrchestratorTurn,
} from "./orchestrator-dispatch.js";
import { startPreparedOrchestratorRun } from "./orchestrator-launch.js";
import {
  getOrchestratorHealth,
  normalizeAutomationRunInput,
  normalizeChatRunInput,
} from "./orchestrator-policy.js";

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

    const { prepared } = await startPreparedOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      replayTurn: payload.requeueOnInterrupt ? payload : null,
      userMessageId: startArgs.userMessageId,
      createRuntimeCallbacks: ({ runId, prepared }) =>
        createRuntimeCallbacks(runId, callbacks, {
          onInterrupted: prepared.replayInterruptedTurn,
        }),
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

  const agentHealthCheck = () => getOrchestratorHealth(context, deps);

  const startLocalChatTurn = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error(
        "The orchestrator is already running. Wait for it to finish before starting another run.",
      );
    }

    const {
      conversationId,
      agentType,
      userPrompt,
    } = normalizeChatRunInput(payload);
    const runId = `local:${crypto.randomUUID()}`;
    if (!userPrompt) {
      throw new Error("Missing user prompt");
    }

    await startPreparedOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      userMessageId: payload.userMessageId,
      webSearch: deps.webSearch,
      createRuntimeCallbacks: ({ runId }) => createRuntimeCallbacks(runId, callbacks),
      finishInterruptedRun,
      cleanupRun,
      onPrepared: (prepared) => {
        logger.debug("handleLocalChat", {
          runId,
          agentType,
          model: prepared.agentContext.model,
          resolvedModel: prepared.resolvedLlm.model.id,
          conversationId,
          tools: prepared.agentContext.toolsAllowlist ?? [],
          threadHistoryCount: prepared.agentContext.threadHistory?.length ?? 0,
        });
      },
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

    return await executeOrQueueUserOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => await startLocalChatTurn(payload, callbacks),
    });
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

    const {
      conversationId,
      userPrompt,
      agentType,
    } = normalizeAutomationRunInput(payload);
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
    await startPreparedOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      userMessageId: `automation:${crypto.randomUUID()}`,
      replayTurn: queuedTurn.requeueOnInterrupt ? queuedTurn : null,
      createRuntimeCallbacks: ({ runId, prepared }) =>
        createRuntimeCallbacks(
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
        ),
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
      void executeOrQueueSystemOrchestratorTurn({
        hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
        queueOrchestratorTurn,
        execute: async (queuedTurn) => {
          await startAutomationTurn(queuedTurn, payload, resolve);
        },
      });
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
