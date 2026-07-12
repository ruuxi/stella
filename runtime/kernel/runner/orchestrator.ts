import crypto from "crypto";
import { AGENT_IDS } from "../../contracts/agent-runtime.js";
import type { RuntimeEndEvent } from "../agent-runtime/types.js";
import { createRuntimePromptAgentMessage } from "../agent-runtime/run-preparation.js";
import { persistThreadPayloadMessage } from "../agent-runtime/thread-memory.js";
import { createRuntimeLogger } from "../debug.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import type { BuildAgentContextArgs } from "./context.js";
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
  prunePendingFollowUpReplies,
  recordPendingFollowUpReplyEntry,
  resolveLiveChatMessageDelivery,
} from "./shared.js";
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
    buildAgentContext: (
      args: BuildAgentContextArgs,
    ) => Promise<LocalAgentContext>;
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
    setFollowUpReplyFlusher,
  } = coordinator;
  const preExecutionCanceledRunIds = new Set<string>();
  const preparingRunIds = new Set<string>();

  type StartPreparedRunArgs = Parameters<
    typeof startPreparedOrchestratorRun
  >[0];
  const createSteerableCallbacks = (initialCallbacks: AgentCallbacks) => {
    let currentCallbacks = initialCallbacks;
    const callbackProxy: AgentCallbacks = {
      onRunStarted: (event) => currentCallbacks.onRunStarted?.(event),
      onUserMessage: (event) => currentCallbacks.onUserMessage?.(event),
      onAssistantMessage: (event) =>
        currentCallbacks.onAssistantMessage?.(event),
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
    selfModMetadata?: StartPreparedRunArgs["selfModMetadata"];
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
    args.callbacks.onRunStarted?.({
      runId,
      agentType: args.agentType,
      seq: 0,
      userMessageId: args.userMessageId,
      ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
      ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
    });

    preparingRunIds.add(runId);
    try {
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
        ...(args.selfModMetadata
          ? { selfModMetadata: args.selfModMetadata }
          : {}),
        createRuntimeCallbacks: (runArgs) =>
          args.createRunCallbacks(runArgs, steerableCallbacks.callbackProxy),
        cleanupRun,
        onPrepared: (prepared) => {
          args.onPrepared?.(prepared);
        },
        onExecutionSessionCreated: (session) => {
          if (context.state.activeOrchestratorRunId !== runId) {
            return;
          }
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
    } catch (error) {
      if (preExecutionCanceledRunIds.delete(runId)) {
        return { runId };
      }
      try {
        args.callbacks.onError({
          runId,
          agentType: args.agentType,
          seq: 0,
          error: error instanceof Error ? error.message : String(error),
          fatal: true,
          ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
        });
      } finally {
        cleanupRun(runId);
      }
      throw error;
    } finally {
      preparingRunIds.delete(runId);
    }

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
        // Fires at the queued user message's `message_start` — the message is
        // now in the model context and about to be answered, so drop its
        // recovery mirror. Otherwise a steered message answered mid-run would
        // be flushed (re-answered) if the run later ended abnormally.
        prunePendingFollowUpReplies(
          context.state.pendingFollowUpReplies,
          args.session.conversationId,
          args.userMessageId,
        );
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
      // Native engine: user messages `"steer"` (delivered at the next safe
      // turn boundary, answered mid-run). External engines: `"followUp"`
      // (their live agent drains only post-turn either way). Runtime-internal
      // injections always `"steer"`. See resolveLiveChatMessageDelivery.
      // Ordering trade-off on native: the queued message can land between the
      // run's preamble and its post-tool answer rather than strictly below
      // the finished answer — accepted in favor of responsiveness.
      const delivery = resolveLiveChatMessageDelivery({
        role: message.role,
        engine: args.session.engine,
      });
      if (message.role === "user") {
        // Mirror for abnormal-termination recovery regardless of delivery
        // mode: a message queued but not yet delivered when the run dies is
        // lost exactly like an undelivered follow-up. Pruned on delivery via
        // the queueUserMessageId onStart above.
        recordPendingFollowUpReply(args.session.conversationId, promptInput.text, args.userMessageId);
      }
      args.session.queueMessage(message, delivery);
    }
  };

  /**
   * Mirror an injected live-run user message so it can be answered after the
   * active run drains. If the run is interrupted or fails before the message
   * is delivered, the agent's in-memory queues are cleared and the user would
   * never get a reply. The buffer is consumed by
   * `flushPendingFollowUpReplies` on abnormal termination, pruned per message
   * on delivery (queueUserMessageId onStart), and discarded on clean
   * completion.
   */
  const recordPendingFollowUpReply = (
    conversationId: string,
    text: string,
    userMessageId?: string,
  ): void => {
    recordPendingFollowUpReplyEntry(
      context.state.pendingFollowUpReplies,
      conversationId,
      { text, ...(userMessageId ? { userMessageId } : {}) },
    );
  };

  /**
   * Fire a fresh reply turn for follow-up user messages that were injected
   * into a run but never answered because the run was interrupted or failed
   * before draining its follow-up queue. The messages are already persisted to
   * the thread (at injection time), so the reply is triggered with a hidden
   * runtime message rather than re-emitting the user turn — this avoids
   * duplicating the user's message in the thread/UI while still producing a
   * real, deliverable assistant reply (a fresh run with its own runId).
   */
  const flushPendingFollowUpReplies = (conversationId: string): void => {
    const pending = context.state.pendingFollowUpReplies.get(conversationId);
    context.state.pendingFollowUpReplies.delete(conversationId);
    if (!pending || pending.length === 0) {
      return;
    }
    const callbacks = getCallbacksForTarget({ conversationId });
    if (!callbacks) {
      return;
    }
    const combinedText = pending.map((entry) => entry.text).join("\n\n");
    queueOrchestratorTurn({
      priority: "user",
      execute: async () => {
        await startStreamingOrchestratorTurn(
          {
            conversationId,
            userPrompt: "",
            promptMessages: [
              {
                text:
                  "The user sent the following message(s) while you were " +
                  "finishing the previous task, and they were never answered " +
                  "because that run ended early. Reply to them now as a " +
                  "direct response to the user:\n\n" +
                  combinedText,
                messageType: "message",
                customType: "runtime.queued_message_reply",
                uiVisibility: UI_VISIBILITY_HIDDEN,
              },
            ],
            agentType: AGENT_IDS.ORCHESTRATOR,
            userMessageId: `message:${crypto.randomUUID()}`,
            uiVisibility: UI_VISIBILITY_VISIBLE,
          },
          callbacks,
        );
      },
    });
  };

  setFollowUpReplyFlusher(flushPendingFollowUpReplies);

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
      const message = createRuntimePromptAgentMessage(
        {
          text,
          messageType: "message",
          customType: input.customType ?? "runtime.send_message",
          ...(input.display !== undefined ? { display: input.display } : {}),
        },
        timestamp,
      );
      liveSession.queueMessage(message, delivery);
      return;
    }

    await executeOrQueueSystemOrchestratorTurn({
      hasActiveRun: Boolean(context.state.activeOrchestratorRunId),
      queueOrchestratorTurn,
      execute: async () => {
        const promptMessages: NonNullable<ChatPayload["promptMessages"]> = [
          {
            text,
            messageType: "message",
            customType: input.customType ?? "runtime.send_message",
            ...(input.display !== undefined ? { display: input.display } : {}),
          },
        ];
        await startStreamingOrchestratorTurn(
          {
            conversationId: input.conversationId,
            userPrompt: "",
            promptMessages,
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
      context.appendLocalChatEvent?.({
        conversationId: input.conversationId,
        type: "user_message",
        requestId: userMessageId,
        timestamp,
        payload: {
          text,
          ...(nextMetadata ? { metadata: nextMetadata } : {}),
        },
      });
    }
    const liveSession = getLiveOrchestratorSession(
      input.conversationId,
      input.agentType,
    );
    if (liveSession) {
      liveSession.queueUserMessageId(userMessageId, () => {
        liveSession.queueCallbackSwitch(callbacks);
        prunePendingFollowUpReplies(
          context.state.pendingFollowUpReplies,
          liveSession.conversationId,
          userMessageId,
        );
      });
      const message = persistInjectedUserMessage(liveSession, text, timestamp);
      if (delivery === "followUp") {
        recordPendingFollowUpReply(liveSession.conversationId, text, userMessageId);
      }
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
      selfModMetadata: payload.selfModMetadata,
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
      modelOverride?: string;
      toolWorkspaceRoot?: string;
      attachments?: StartPreparedRunArgs["attachments"];
      connectorDeliveryTarget?: StartPreparedRunArgs["connectorDeliveryTarget"];
    },
    resolveResult: (value: AutomationTurnResult) => void,
  ): Promise<{ runId: string }> => {
    try {
      if (context.state.activeOrchestratorRunId) {
        throw new Error("The orchestrator is already running.");
      }

      const {
        conversationId,
        userPrompt,
        agentType,
        modelOverride,
        toolWorkspaceRoot,
        attachments,
        connectorDeliveryTarget,
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
      const appendConnectorTerminalNotice = (event: RuntimeEndEvent) => {
        if (!connectorDeliveryTarget) {
          return;
        }
        if (event.responseTarget?.type !== "agent_terminal_notice") {
          return;
        }
        const text = event.finalText.trim();
        if (!text) {
          return;
        }
        context.appendLocalChatEvent?.({
          conversationId,
          type: "assistant_message",
          payload: { text },
        });
      };
      await startPreparedOrchestratorRun({
        context,
        buildAgentContext: deps.buildAgentContext,
        runId,
        conversationId,
        agentType,
        userPrompt,
        ...(modelOverride ? { modelOverride } : {}),
        ...(toolWorkspaceRoot ? { toolWorkspaceRoot } : {}),
        uiVisibility: "hidden",
        attachments,
        ...(connectorDeliveryTarget ? { connectorDeliveryTarget } : {}),
        userMessageId: `automation:${crypto.randomUUID()}`,
        createRuntimeCallbacks: ({ runId }) =>
          createRuntimeCallbacks(
            runId,
            createAutomationAgentCallbacks(resolveResult, {
              onEnd: appendConnectorTerminalNotice,
            }),
          ),
        cleanupRun,
        onFatalError: createAutomationFatalErrorHandler(resolveResult),
      });

      return { runId };
    } catch (error) {
      // Any throw before the run's callbacks take over (already-running guard,
      // prepareOrchestratorRun rejecting on a missing model route/API key, etc.)
      // must still settle the caller's promise. resolveResult is the Promise's
      // own resolve, so a later callback-driven resolve is a harmless no-op.
      resolveResult(
        createAutomationErrorResult((error as Error)?.message ?? String(error)),
      );
      return { runId: "" };
    }
  };

  const runAutomationTurn = async (payload: {
    conversationId: string;
    userPrompt: string;
    agentType?: string;
    modelOverride?: string;
    toolWorkspaceRoot?: string;
    attachments?: StartPreparedRunArgs["attachments"];
    connectorDeliveryTarget?: StartPreparedRunArgs["connectorDeliveryTarget"];
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
    const wasPreExecution = preparingRunIds.has(runId);
    const uiVisibility = context.state.activeOrchestratorUiVisibility;
    const callbacks = context.state.runCallbacksByRunId.get(runId);
    controller.abort();
    if (wasPreExecution) {
      preExecutionCanceledRunIds.add(runId);
      cleanupRun(runId);
      callbacks?.onInterrupted?.({
        runId,
        agentType: AGENT_IDS.ORCHESTRATOR,
        uiVisibility,
        reason: "Canceled",
      });
      return;
    }
    context.state.activeRunAbortControllers.delete(runId);
    clearActiveOrchestratorRun(runId);
  };

  /**
   * Cancel whichever orchestrator run is currently active for the given
   * conversation. There can only be one active orchestrator run per
   * conversation at a time (see `activeOrchestratorRunId` /
   * `activeOrchestratorConversationId`), so this is unambiguous when the
   * conversation owns the live run; otherwise it's a no-op.
   *
   * Returns `true` if a run was cancelled, `false` if none matched.
   */
  const cancelLocalChatByConversation = (conversationId: string): boolean => {
    const activeConversationId = context.state.activeOrchestratorConversationId;
    const activeRunId = context.state.activeOrchestratorRunId;
    if (!activeRunId || activeConversationId !== conversationId) {
      return false;
    }
    cancelLocalChat(activeRunId);
    return true;
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
    cancelLocalChatByConversation,
    getActiveOrchestratorRun,
  };
};
