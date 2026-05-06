import crypto from "crypto";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import { createRuntimePromptAgentMessage } from "../agent-runtime/run-preparation.js";
import { persistThreadPayloadMessage } from "../agent-runtime/thread-memory.js";
import { createRuntimeLogger } from "../debug.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type {
  ActiveOrchestratorSession,
  AgentCallbacks,
  ChatPayload,
  RunnerContext,
  RuntimeSendMessageInput,
  RuntimeSendUserMessageInput,
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
const UI_VISIBILITY_HIDDEN = "hidden" as const;
const UI_VISIBILITY_VISIBLE = "visible" as const;

const asMetadataRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;

export const createOrchestratorController = (
  context: RunnerContext,
  deps: {
    buildAgentContext: (args: {
      conversationId: string;
      agentType: string;
      runId: string;
      threadId?: string;
      selfModMetadata?: import("../tools/types.js").AgentToolRequest["selfModMetadata"];
      shouldInjectDynamicMemory?: boolean;
    }) => Promise<LocalAgentContext>;
    resolveAgent: (agentType: string) => unknown;
    getConfiguredModel: (
      agentType: string,
      agent?: unknown,
    ) => string | undefined;
  },
) => {
  const coordinator = createOrchestratorCoordinator(context);
  const {
    cleanupRun,
    clearActiveOrchestratorRun,
    createRuntimeCallbacks,
    queueOrchestratorTurn,
  } = coordinator;

  type StartPreparedRunArgs = Parameters<
    typeof startPreparedOrchestratorRun
  >[0];
  const createSteerableCallbacks = (initialCallbacks: AgentCallbacks) => {
    let currentCallbacks = initialCallbacks;
    const callbackProxy: AgentCallbacks = {
      onRunStarted: (event) => currentCallbacks.onRunStarted?.(event),
      onUserMessage: (event) => currentCallbacks.onUserMessage?.(event),
      onStream: (event) => currentCallbacks.onStream(event),
      onAgentReasoning: (event) => currentCallbacks.onAgentReasoning?.(event),
      onStatus: (event) => currentCallbacks.onStatus?.(event),
      onToolStart: (event) => currentCallbacks.onToolStart(event),
      onToolEnd: (event) => currentCallbacks.onToolEnd(event),
      onError: (event) => currentCallbacks.onError(event),
      onInterrupted: (event) => currentCallbacks.onInterrupted?.(event),
      onEnd: (event) => currentCallbacks.onEnd(event),
    };

    return {
      callbackProxy,
      switchTo(nextCallbacks: AgentCallbacks) {
        currentCallbacks = nextCallbacks;
      },
    };
  };

  const launchOrchestratorRun = async (args: {
    alreadyRunningError: string;
    conversationId: string;
    agentType: string;
    userPrompt: string;
    uiVisibility?: "visible" | "hidden";
    promptMessages?: ChatPayload["promptMessages"];
    attachments: StartPreparedRunArgs["attachments"];
    userMessageId: string;
    responseTarget?: StartPreparedRunArgs["responseTarget"];
    callbacks: AgentCallbacks;
    createRunCallbacks: (
      args: Parameters<StartPreparedRunArgs["createRuntimeCallbacks"]>[0],
      callbacks: AgentCallbacks,
    ) => ReturnType<StartPreparedRunArgs["createRuntimeCallbacks"]>;
    onPrepared?: StartPreparedRunArgs["onPrepared"];
  }): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error(args.alreadyRunningError);
    }

    const runId = `local:${crypto.randomUUID()}`;
    const steerableCallbacks = createSteerableCallbacks(args.callbacks);
    context.state.runCallbacksByRunId.set(runId, args.callbacks);
    if (args.uiVisibility !== UI_VISIBILITY_HIDDEN) {
      context.state.conversationCallbacks.set(
        args.conversationId,
        args.callbacks,
      );
    }

    await startPreparedOrchestratorRun({
      context,
      buildAgentContext: deps.buildAgentContext,
      runId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      userPrompt: args.userPrompt,
      ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
      ...(args.promptMessages?.length
        ? { promptMessages: args.promptMessages }
        : {}),
      attachments: args.attachments,
      userMessageId: args.userMessageId,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
      createRuntimeCallbacks: (runArgs) =>
        args.createRunCallbacks(runArgs, steerableCallbacks.callbackProxy),
      cleanupRun,
      onPrepared: (prepared) => {
        args.callbacks.onRunStarted?.({
          runId: prepared.runId,
          agentType: args.agentType,
          seq: 0,
          userMessageId: args.userMessageId,
          ...(args.responseTarget
            ? { responseTarget: args.responseTarget }
            : {}),
          ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
        });
        args.onPrepared?.(prepared);
      },
      onExecutionSessionCreated: (session) => {
        context.state.activeOrchestratorSession = {
          ...session,
          conversationId: args.conversationId,
          agentType: args.agentType,
          uiVisibility: args.uiVisibility ?? UI_VISIBILITY_VISIBLE,
          queueCallbackSwitch: (callbacks) => {
            steerableCallbacks.switchTo(callbacks);
          },
          queueMessage: (
            message: AgentMessage,
            delivery: "steer" | "followUp",
          ) => {
            if (delivery === "followUp") {
              session.agent.followUp(message);
              return;
            }
            session.agent.steer(message);
          },
        } satisfies ActiveOrchestratorSession;
      },
      onFatalError: createOrchestratorFatalErrorHandler({
        runId,
        agentType: args.agentType,
        callbacks: args.callbacks,
      }),
    });

    return { runId };
  };

  const startStreamingOrchestratorTurn = async (
    startArgs: {
      conversationId: string;
      userPrompt: string;
      promptMessages?: ChatPayload["promptMessages"];
      agentType: string;
      userMessageId: string;
      uiVisibility?: "visible" | "hidden";
      responseTarget?: StartPreparedRunArgs["responseTarget"];
    },
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const conversationId = startArgs.conversationId;
    const agentType = startArgs.agentType;
    const userPrompt = startArgs.userPrompt.trim();
    const promptMessages = startArgs.promptMessages;
    const hasPromptMessages = Boolean(
      promptMessages?.some((message) => message.text.trim().length > 0),
    );
    if (!userPrompt && !hasPromptMessages) {
      throw new Error("Missing user prompt");
    }

    return await launchOrchestratorRun({
      alreadyRunningError: "The orchestrator is already running.",
      conversationId,
      agentType,
      userPrompt,
      ...(startArgs.uiVisibility
        ? { uiVisibility: startArgs.uiVisibility }
        : {}),
      ...(promptMessages?.length ? { promptMessages } : {}),
      attachments: [],
      userMessageId: startArgs.userMessageId,
      ...(startArgs.responseTarget
        ? { responseTarget: startArgs.responseTarget }
        : {}),
      callbacks,
      createRunCallbacks: ({ runId }, callbacks) =>
        createRuntimeCallbacks(runId, callbacks),
    });
  };

  const agentHealthCheck = () => getOrchestratorHealth(context, deps);

  const getCallbacksForTarget = (args: {
    conversationId: string;
    callbackRunId?: string;
  }): AgentCallbacks | null => {
    const callbacks =
      (args.callbackRunId
        ? context.state.runCallbacksByRunId.get(args.callbackRunId)
        : null) ??
      context.state.conversationCallbacks.get(args.conversationId) ??
      null;
    if (!callbacks) {
      logger.debug("missing-conversation-callbacks", {
        conversationId: args.conversationId,
        callbackRunId: args.callbackRunId,
      });
    }
    return callbacks;
  };

  const getLiveOrchestratorSession = (
    conversationId: string,
    agentType?: string,
  ): ActiveOrchestratorSession | null => {
    const session = context.state.activeOrchestratorSession;
    if (!session || !session.agent.state.isStreaming) {
      return null;
    }
    if (session.uiVisibility !== UI_VISIBILITY_VISIBLE) {
      return null;
    }
    if (session.conversationId !== conversationId) {
      return null;
    }
    if (agentType && session.agentType !== agentType) {
      return null;
    }
    return session;
  };

  const buildInjectedInternalMessage = (
    input: RuntimeSendMessageInput,
    timestamp: number,
  ): AgentMessage =>
    createRuntimePromptAgentMessage(
      {
        text: input.text.trim(),
        messageType: "message",
        customType: input.customType ?? "runtime.send_message",
        ...(input.display !== undefined ? { display: input.display } : {}),
      },
      timestamp,
    );

  const persistInjectedUserMessage = (
    session: ActiveOrchestratorSession,
    text: string,
    timestamp: number,
  ): AgentMessage => {
    const payload = createRuntimePromptAgentMessage(
      {
        text,
        messageType: "user",
      },
      timestamp,
    );
    if (payload.role === "user") {
      persistThreadPayloadMessage(context.runtimeStore, {
        threadKey: session.threadKey,
        payload,
      });
    }
    return payload;
  };

  const persistAndQueueLiveChatMessages = (args: {
    session: ActiveOrchestratorSession;
    userMessageId: string;
    userPrompt: string;
    promptMessages?: ChatPayload["promptMessages"];
    attachments: StartPreparedRunArgs["attachments"];
    callbacks: AgentCallbacks;
  }) => {
    const trimmedUserPrompt = args.userPrompt.trim();
    const promptInputs =
      args.promptMessages && args.promptMessages.length > 0
        ? [
            ...args.promptMessages,
            ...(trimmedUserPrompt
              ? [{ text: trimmedUserPrompt, messageType: "user" as const }]
              : []),
          ]
        : [{ text: trimmedUserPrompt, messageType: "user" as const }];
    const timestamp = Date.now();
    if (promptInputs.some((message) => message.messageType !== "message")) {
      args.session.queueUserMessageId(args.userMessageId, () => {
        args.session.queueCallbackSwitch(args.callbacks);
      });
    }
    for (const [index, promptInput] of promptInputs.entries()) {
      const message = createRuntimePromptAgentMessage(
        {
          ...promptInput,
          ...(index === promptInputs.length - 1 && args.attachments.length
            ? { attachments: args.attachments }
            : {}),
        },
        timestamp + index,
      );
      if (message.role === "user") {
        persistThreadPayloadMessage(context.runtimeStore, {
          threadKey: args.session.threadKey,
          payload: message,
        });
      }
      args.session.queueMessage(message, "steer");
    }
  };

  const appendVisibleUserChatEvent = (args: {
    conversationId: string;
    userMessageId: string;
    text: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }) => {
    context.appendLocalChatEvent?.({
      conversationId: args.conversationId,
      type: "user_message",
      requestId: args.userMessageId,
      timestamp: args.timestamp,
      payload: {
        text: args.text,
        ...(args.metadata ? { metadata: args.metadata } : {}),
      },
    });
  };

  const sendMessage = async (input: RuntimeSendMessageInput): Promise<void> => {
    const text = input.text.trim();
    if (!text) {
      return;
    }
    const callbacks = getCallbacksForTarget({
      conversationId: input.conversationId,
      callbackRunId: input.callbackRunId,
    });
    if (!callbacks) {
      return;
    }
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }
    const delivery = input.deliverAs ?? "steer";
    const liveSession = getLiveOrchestratorSession(
      input.conversationId,
      input.agentType,
    );
    if (liveSession) {
      const timestamp = Date.now();
      const message = buildInjectedInternalMessage(input, timestamp);
      liveSession.queueMessage(message, delivery);
      return;
    }

    const promptText = input.wakePrompt?.trim() || text;
    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => {
        await startStreamingOrchestratorTurn(
          {
            conversationId: input.conversationId,
            userPrompt: "",
            promptMessages: [
              {
                text: promptText,
                messageType: "message",
                customType: input.customType ?? "runtime.send_message",
                ...(input.display !== undefined
                  ? { display: input.display }
                  : {}),
              },
            ],
            agentType: input.agentType ?? AGENT_IDS.ORCHESTRATOR,
            userMessageId: `message:${crypto.randomUUID()}`,
            uiVisibility: UI_VISIBILITY_VISIBLE,
            ...(input.responseTarget
              ? { responseTarget: input.responseTarget }
              : {}),
          },
          callbacks,
        );
      },
    });
  };

  const sendUserMessage = async (
    input: RuntimeSendUserMessageInput,
  ): Promise<void> => {
    const text = input.text.trim();
    if (!text) {
      return;
    }
    const callbacks = getCallbacksForTarget({
      conversationId: input.conversationId,
    });
    if (!callbacks) {
      return;
    }
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    const userMessageId = `local:${crypto.randomUUID()}`;
    const uiVisibility = input.uiVisibility ?? UI_VISIBILITY_VISIBLE;
    const runtimePromptVisibility = UI_VISIBILITY_HIDDEN;
    const delivery = input.deliverAs ?? "steer";
    const timestamp = Date.now();
    const metadata = asMetadataRecord(input.metadata);
    const uiMetadata = asMetadataRecord(metadata?.ui);
    const nextMetadata =
      metadata || uiVisibility === UI_VISIBILITY_HIDDEN
        ? {
            ...(metadata ?? {}),
            ui: {
              ...(uiMetadata ?? {}),
              visibility: uiVisibility,
            },
          }
        : undefined;
    if (uiVisibility !== UI_VISIBILITY_HIDDEN) {
      appendVisibleUserChatEvent({
        conversationId: input.conversationId,
        userMessageId,
        text,
        timestamp,
        ...(nextMetadata ? { metadata: nextMetadata } : {}),
      });
    }
    const liveSession = getLiveOrchestratorSession(
      input.conversationId,
      input.agentType,
    );
    if (liveSession) {
      liveSession.queueUserMessageId(userMessageId, () => {
        liveSession.queueCallbackSwitch(callbacks);
      });
      const message = persistInjectedUserMessage(liveSession, text, timestamp);
      liveSession.queueMessage(message, delivery);
      return;
    }

    await executeOrQueueUserOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () =>
        await startLocalChatTurn(
          {
            conversationId: input.conversationId,
            userMessageId,
            userPrompt: "",
            promptMessages: [
              {
                text,
                uiVisibility: runtimePromptVisibility,
                messageType: "user",
              },
            ],
            agentType: input.agentType,
          },
          callbacks,
        ),
    });
  };

  const startLocalChatTurn = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const {
      conversationId,
      agentType,
      userPrompt,
      promptMessages,
      attachments,
    } = normalizeChatRunInput(payload);
    const hasPromptMessages = Boolean(
      promptMessages?.some((message) => message.text.trim().length > 0),
    );
    if (!userPrompt && attachments.length === 0 && !hasPromptMessages) {
      throw new Error("Missing user prompt");
    }

    const liveSession = getLiveOrchestratorSession(conversationId, agentType);
    if (liveSession) {
      persistAndQueueLiveChatMessages({
        session: liveSession,
        userMessageId: payload.userMessageId,
        userPrompt,
        promptMessages,
        attachments,
        callbacks,
      });
      return { runId: liveSession.runId };
    }

    return await launchOrchestratorRun({
      alreadyRunningError:
        "The orchestrator is already running. Wait for it to finish before starting another run.",
      conversationId,
      agentType,
      userPrompt,
      ...(promptMessages?.length ? { promptMessages } : {}),
      attachments,
      userMessageId: payload.userMessageId,
      callbacks,
      createRunCallbacks: ({ runId }, callbacks) =>
        createRuntimeCallbacks(runId, callbacks),
      onPrepared: (prepared) => {
        const runId = prepared.runId;
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
    });
  };

  const handleLocalChat = async (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ): Promise<{ runId: string }> => {
    const health = agentHealthCheck();
    if (!health.ready) {
      throw new Error(health.reason ?? "Stella runtime not ready");
    }

    const liveSession = getLiveOrchestratorSession(
      payload.conversationId,
      payload.agentType,
    );
    if (liveSession) {
      return await startLocalChatTurn(payload, callbacks);
    }

    return await executeOrQueueUserOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => await startLocalChatTurn(payload, callbacks),
    });
  };

  const startAutomationTurn = async (
    payload: {
      conversationId: string;
      userPrompt: string;
      agentType?: string;
      toolWorkspaceRoot?: string;
    },
    resolveResult: (value: AutomationTurnResult) => void,
  ): Promise<{ runId: string }> => {
    if (context.state.activeOrchestratorRunId) {
      throw new Error("The orchestrator is already running.");
    }

    const { conversationId, userPrompt, agentType, toolWorkspaceRoot } =
      normalizeAutomationRunInput(payload);
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
      runId,
      conversationId,
      agentType,
      userPrompt,
      ...(toolWorkspaceRoot ? { toolWorkspaceRoot } : {}),
      uiVisibility: "hidden",
      attachments: [],
      userMessageId: `automation:${crypto.randomUUID()}`,
      createRuntimeCallbacks: ({ runId }) =>
        createRuntimeCallbacks(
          runId,
          createAutomationAgentCallbacks(resolveResult),
        ),
      cleanupRun,
      onFatalError: createAutomationFatalErrorHandler(resolveResult),
    });

    return { runId };
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
    toolWorkspaceRoot?: string;
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
        execute: async () => {
          await startAutomationTurn(payload, resolve);
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
    uiVisibility?: "visible" | "hidden";
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
      uiVisibility: context.state.activeOrchestratorUiVisibility,
    };
  };

  return {
    agentHealthCheck,
    queueOrchestratorTurn,
    startStreamingOrchestratorTurn,
    handleLocalChat,
    sendMessage,
    sendUserMessage,
    runAutomationTurn,
    cancelLocalChat,
    getActiveOrchestratorRun,
  };
};
