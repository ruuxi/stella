import crypto from "crypto";
import { createRuntimeLogger } from "../debug.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import type {
  RunnerContext,
  AgentCallbacks,
  ChatPayload,
  QueuedOrchestratorTurn,
} from "./types.js";
import {
  createAutomationAgentCallbacks,
  createAutomationErrorResult,
  createAutomationFatalErrorHandler,
  createOrchestratorFatalErrorHandler,
  type AutomationTurnResult,
} from "./orchestrator-callbacks.js";
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

    await startPreparedOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      queueOrchestratorTurn,
      runId,
      conversationId,
      agentType,
      userPrompt,
      attachments: [],
      replayTurn: payload.requeueOnInterrupt ? payload : null,
      userMessageId: startArgs.userMessageId,
      createRuntimeCallbacks: ({ runId, prepared }) =>
        createRuntimeCallbacks(runId, callbacks, {
          onInterrupted: prepared.replayInterruptedTurn,
        }),
      webSearch: deps.webSearch,
      finishInterruptedRun,
      cleanupRun,
      onFatalError: createOrchestratorFatalErrorHandler({
        runId,
        agentType,
        callbacks,
      }),
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
      attachments,
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
      attachments,
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
      onFatalError: createOrchestratorFatalErrorHandler({
        runId,
        agentType,
        callbacks,
      }),
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
    resolveResult: (value: AutomationTurnResult) => void,
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
      resolveResult(createAutomationErrorResult("Missing conversationId"));
      return { runId: "" };
    }
    if (!userPrompt) {
      resolveResult(createAutomationErrorResult("Missing user prompt"));
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
      attachments: [],
      userMessageId: `automation:${crypto.randomUUID()}`,
      replayTurn: queuedTurn.requeueOnInterrupt ? queuedTurn : null,
      createRuntimeCallbacks: ({ runId, prepared }) =>
        createRuntimeCallbacks(
          runId,
          createAutomationAgentCallbacks(resolveResult),
          {
            onInterrupted: prepared.replayInterruptedTurn,
          },
        ),
      webSearch: deps.webSearch,
      finishInterruptedRun,
      cleanupRun,
      onFatalError: createAutomationFatalErrorHandler(resolveResult),
    });

    return { runId };
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
  }): Promise<AutomationTurnResult> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      return createAutomationErrorResult(
        health.reason ?? "Stella runtime not ready",
      );
    }

    return await new Promise<AutomationTurnResult>((resolve) => {
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
