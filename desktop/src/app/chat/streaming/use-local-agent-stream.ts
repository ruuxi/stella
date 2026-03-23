import { useCallback, useRef, useState } from "react";
import { showToast } from "@/ui/toast";
import {
  AGENT_IDS,
  AGENT_STREAM_EVENT_TYPES,
  type AgentIdLike,
} from "@/shared/contracts/agent-runtime";
import { useRafStringAccumulator } from "@/shared/hooks/use-raf-state";
import { useResumeAgentRun } from "../hooks/use-resume-agent-run";
import type { AgentStreamEvent, SelfModAppliedData } from "./streaming-types";
import type { AttachmentRef } from "./chat-types";
import {
  getAgentHealthReason,
  resolveAgentNotReadyToast,
  trySyncHostToken,
} from "./agent-stream-errors";

export type LocalAgentTaskEventType =
  | typeof AGENT_STREAM_EVENT_TYPES.TASK_STARTED
  | typeof AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED
  | typeof AGENT_STREAM_EVENT_TYPES.TASK_FAILED
  | typeof AGENT_STREAM_EVENT_TYPES.TASK_CANCELED
  | typeof AGENT_STREAM_EVENT_TYPES.TASK_PROGRESS;

export type LocalAgentEvent = {
  type:
    | "tool_request"
    | "tool_result"
    | "assistant_message"
    | LocalAgentTaskEventType;
  agentType?: AgentIdLike;
  userMessageId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  finalText?: string;
  taskId?: string;
  description?: string;
  parentTaskId?: string;
  result?: string;
  error?: string;
  statusText?: string;
};

type UseLocalAgentStreamOptions = {
  activeConversationId: string | null;
  storageMode: "cloud" | "local";
  appendAgentEvent: (event: LocalAgentEvent) => Promise<void> | void;
};

type StartStreamArgs = {
  userMessageId: string;
  userPrompt: string;
  attachments?: AttachmentRef[];
};

function attachmentsForStartChat(
  attachments: AttachmentRef[] | undefined,
): { url: string; mimeType?: string }[] | undefined {
  if (!attachments?.length) return undefined;
  const mapped = attachments
    .filter(
      (a): a is AttachmentRef & { url: string } =>
        typeof a.url === "string" && a.url.length > 0,
    )
    .map((a) => {
      const item: { url: string; mimeType?: string } = { url: a.url };
      if (a.mimeType) item.mimeType = a.mimeType;
      return item;
    });
  return mapped.length ? mapped : undefined;
}

const isTokenSyncIssue = (reason: string | null) =>
  Boolean(reason && reason.toLowerCase().match(/token|auth/));

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
  appendAgentEvent,
}: UseLocalAgentStreamOptions) {
  const [
    streamingText,
    appendStreamingDelta,
    resetStreamingText,
    streamingTextRef,
  ] = useRafStringAccumulator();
  const [reasoningText, , resetReasoningText] = useRafStringAccumulator();
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null);
  const [selfModMap, setSelfModMap] = useState<
    Record<string, SelfModAppliedData>
  >({});

  const streamRunIdRef = useRef(0);
  const localRunIdRef = useRef<string | null>(null);
  const localSeqByRunIdRef = useRef(new Map<string, number>());
  const userMessageIdByRunIdRef = useRef(new Map<string, string>());
  const latestUserMessageIdRef = useRef<string | null>(null);
  const cancelledStreamRunIdsRef = useRef(new Set<number>());
  const queuedRunStartsRef = useRef<
    Array<{ runId: string; userMessageId: string }>
  >([]);
  const pendingQueuedStartCountRef = useRef(0);
  const agentStreamCleanupRef = useRef<(() => void) | null>(null);

  const resetStreamingState = useCallback(
    (runId?: number) => {
      if (typeof runId === "number" && runId !== streamRunIdRef.current) {
        return;
      }

      const scheduledForRunId = streamRunIdRef.current;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(false);

      requestAnimationFrame(() => {
        if (scheduledForRunId !== streamRunIdRef.current) {
          return;
        }

        setPendingUserMessageId(null);
      });
    },
    [resetReasoningText, resetStreamingText],
  );

  const activateNextQueuedRun = useCallback(() => {
    if (localRunIdRef.current) {
      return;
    }

    const nextRun = queuedRunStartsRef.current.shift();
    if (!nextRun) {
      return;
    }

    localRunIdRef.current = nextRun.runId;
    userMessageIdByRunIdRef.current.set(nextRun.runId, nextRun.userMessageId);
    resetStreamingText();
    resetReasoningText();
    setIsStreaming(true);
    setPendingUserMessageId(nextRun.userMessageId);
  }, [resetReasoningText, resetStreamingText]);

  const cancelCurrentStream = useCallback(() => {
    const runIdCounter = streamRunIdRef.current;
    if (runIdCounter > 0) {
      cancelledStreamRunIdsRef.current.add(runIdCounter);
      streamRunIdRef.current = runIdCounter + 1;
    }

    if (localRunIdRef.current && window.electronAPI?.agent.cancelChat) {
      window.electronAPI.agent.cancelChat(localRunIdRef.current);
    }

    userMessageIdByRunIdRef.current.clear();
    localSeqByRunIdRef.current.clear();
    queuedRunStartsRef.current = [];
    pendingQueuedStartCountRef.current = 0;
    localRunIdRef.current = null;
    resetStreamingState();

    if (agentStreamCleanupRef.current) {
      agentStreamCleanupRef.current();
      agentStreamCleanupRef.current = null;
    }
  }, [resetStreamingState]);

  const handleAgentEvent = useCallback(
    (event: AgentStreamEvent, runIdCounter: number) => {
      if (runIdCounter !== streamRunIdRef.current) return;
      const currentSeq = localSeqByRunIdRef.current.get(event.runId) ?? 0;
      if (event.seq <= currentSeq) return;

      localSeqByRunIdRef.current.set(event.runId, event.seq);
      const isPrimaryRun =
        !localRunIdRef.current || event.runId === localRunIdRef.current;
      const isOrchestratorEvent =
        (event.agentType ?? AGENT_IDS.ORCHESTRATOR) === AGENT_IDS.ORCHESTRATOR;

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.STREAM:
          if (isPrimaryRun && isOrchestratorEvent && event.chunk) {
            appendStreamingDelta(event.chunk);
          }
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
          console.log(
            `[stella:trace] tool-start | ${event.toolName} | callId=${event.toolCallId}`,
          );
          appendAgentEvent({
            type: "tool_request",
            agentType: event.agentType,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
          console.log(
            `[stella:trace] tool-end   | ${event.toolName} | callId=${event.toolCallId} | preview=${event.resultPreview?.slice(0, 120)}`,
          );
          appendAgentEvent({
            type: "tool_result",
            agentType: event.agentType,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            resultPreview: event.resultPreview,
          });
          break;
        case AGENT_STREAM_EVENT_TYPES.TASK_STARTED:
        case AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED:
        case AGENT_STREAM_EVENT_TYPES.TASK_FAILED:
        case AGENT_STREAM_EVENT_TYPES.TASK_CANCELED:
        case AGENT_STREAM_EVENT_TYPES.TASK_PROGRESS:
          console.log(
            `[stella:trace] ${event.type} | taskId=${event.taskId} | agent=${event.agentType} | status=${event.statusText ?? event.result ?? event.error ?? event.description ?? ""}`.trim(),
          );
          appendAgentEvent({
            type: event.type,
            agentType: event.agentType,
            taskId: event.taskId,
            description: event.description,
            parentTaskId: event.parentTaskId,
            result: event.result,
            error: event.error,
            statusText: event.statusText,
          });
          break;
        case AGENT_STREAM_EVENT_TYPES.ERROR:
          console.error(
            `[stella:trace] error | fatal=${event.fatal} | ${event.error}`,
          );
          if (event.fatal && isPrimaryRun && isOrchestratorEvent) {
            if (localRunIdRef.current === event.runId) {
              localRunIdRef.current = null;
            }
            userMessageIdByRunIdRef.current.delete(event.runId);
            localSeqByRunIdRef.current.delete(event.runId);
            showToast({
              title: "Something went wrong",
              description: event.error || undefined,
              variant: "error",
            });
            if (queuedRunStartsRef.current.length === 0) {
              resetStreamingState(runIdCounter);
            }
            activateNextQueuedRun();
          }
          break;
        case AGENT_STREAM_EVENT_TYPES.END:
          if (!isPrimaryRun || !isOrchestratorEvent) {
            break;
          }
          {
            const linkedUserMessageId = userMessageIdByRunIdRef.current.get(
              event.runId,
            );
            const visibleUserMessageId =
              linkedUserMessageId ??
              latestUserMessageIdRef.current ??
              undefined;
            console.log(
              `[stella:trace] end | finalText=${(event.finalText ?? streamingTextRef.current).slice(0, 200)}`,
            );
            void Promise.resolve(
              appendAgentEvent({
                type: "assistant_message",
                userMessageId: visibleUserMessageId,
                finalText: event.finalText ?? streamingTextRef.current,
              }),
            )
              .then(() => {
                if (
                  !linkedUserMessageId &&
                  queuedRunStartsRef.current.length === 0
                ) {
                  resetStreamingState(runIdCounter);
                }
                if (localRunIdRef.current === event.runId) {
                  localRunIdRef.current = null;
                }
                localSeqByRunIdRef.current.delete(event.runId);
                activateNextQueuedRun();
              })
              .catch(() => {
                if (queuedRunStartsRef.current.length === 0) {
                  resetStreamingState(runIdCounter);
                }
                if (localRunIdRef.current === event.runId) {
                  localRunIdRef.current = null;
                }
                localSeqByRunIdRef.current.delete(event.runId);
                activateNextQueuedRun();
              });

            userMessageIdByRunIdRef.current.delete(event.runId);

            if (event.selfModApplied && linkedUserMessageId) {
              const userMessageId = linkedUserMessageId;
              const selfModApplied = event.selfModApplied;
              setSelfModMap((previous) => ({
                ...previous,
                [userMessageId]: selfModApplied,
              }));
            }
          }
          break;
      }
    },
    [
      activateNextQueuedRun,
      appendAgentEvent,
      appendStreamingDelta,
      resetStreamingState,
      streamingTextRef,
    ],
  );

  const ensureAgentStreamSubscription = useCallback(
    (runIdCounter: number) => {
      if (
        !window.electronAPI?.agent.onStream ||
        agentStreamCleanupRef.current
      ) {
        return;
      }

      agentStreamCleanupRef.current = window.electronAPI.agent.onStream(
        (event) => {
          handleAgentEvent(event, runIdCounter);
        },
      );
    },
    [handleAgentEvent],
  );

  const startLocalStream = useCallback(
    (args: StartStreamArgs, runIdCounter: number) => {
      if (!activeConversationId || !window.electronAPI) {
        return;
      }

      ensureAgentStreamSubscription(runIdCounter);

      const startChatAttachments = attachmentsForStartChat(args.attachments);

      window.electronAPI.agent
        .startChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          userPrompt: args.userPrompt,
          ...(startChatAttachments?.length
            ? { attachments: startChatAttachments }
            : {}),
          storageMode,
        })
        .then(({ runId: agentRunId }) => {
          const wasCancelled =
            cancelledStreamRunIdsRef.current.has(runIdCounter);
          if (runIdCounter !== streamRunIdRef.current) {
            if (wasCancelled && window.electronAPI?.agent.cancelChat) {
              window.electronAPI.agent.cancelChat(agentRunId);
              cancelledStreamRunIdsRef.current.delete(runIdCounter);
            }
            return;
          }

          cancelledStreamRunIdsRef.current.delete(runIdCounter);
          localRunIdRef.current = agentRunId;
          userMessageIdByRunIdRef.current.set(agentRunId, args.userMessageId);
        })
        .catch((error) => {
          cancelledStreamRunIdsRef.current.delete(runIdCounter);
          if (runIdCounter !== streamRunIdRef.current) return;

          console.error(
            "Failed to start local agent chat:",
            (error as Error).message,
          );

          showToast({
            title: "Stella couldn't start this reply",
            description: (error as Error).message || "Please try again.",
            variant: "error",
          });
          resetStreamingState(runIdCounter);
        });
    },
    [
      activeConversationId,
      ensureAgentStreamSubscription,
      resetStreamingState,
      storageMode,
    ],
  );

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId) {
        return;
      }

      const runId = streamRunIdRef.current + 1;
      streamRunIdRef.current = runId;
      latestUserMessageIdRef.current = args.userMessageId;
      localRunIdRef.current = null;
      localSeqByRunIdRef.current.clear();
      userMessageIdByRunIdRef.current.clear();
      queuedRunStartsRef.current = [];
      pendingQueuedStartCountRef.current = 0;
      resetStreamingText();
      resetReasoningText();
      setIsStreaming(true);
      setPendingUserMessageId(args.userMessageId);

      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
        agentStreamCleanupRef.current = null;
      }

      if (!window.electronAPI?.agent.healthCheck) {
        console.error("[chat] Local agent not available (no electronAPI)");
        showToast({ title: "Stella agent is not running", variant: "error" });
        resetStreamingState(runId);
        return;
      }

      void window.electronAPI.agent
        .healthCheck()
        .then(async (health) => {
          if (runId !== streamRunIdRef.current) return;

          let nextHealth = health;
          let reason = getAgentHealthReason(nextHealth);

          if (!nextHealth?.ready && isTokenSyncIssue(reason)) {
            const synced = await trySyncHostToken();
            if (runId !== streamRunIdRef.current) return;

            if (synced && window.electronAPI?.agent.healthCheck) {
              nextHealth = await window.electronAPI.agent.healthCheck();
              if (runId !== streamRunIdRef.current) return;
              reason = getAgentHealthReason(nextHealth);
            }
          }

          if (!nextHealth?.ready) {
            console.error(
              "[chat] Local agent health check failed:",
              nextHealth,
            );
            const toast = resolveAgentNotReadyToast(reason);
            showToast({
              title: toast.title,
              description: toast.description,
              variant: "error",
            });
            resetStreamingState(runId);
            return;
          }

          startLocalStream(args, runId);
        })
        .catch((error) => {
          if (runId !== streamRunIdRef.current) return;

          console.error(
            "[chat] Local agent health check error:",
            (error as Error).message,
          );
          showToast({
            title: "Stella agent is not responding",
            variant: "error",
          });
          resetStreamingState(runId);
        });
    },
    [
      activeConversationId,
      resetReasoningText,
      resetStreamingState,
      resetStreamingText,
      startLocalStream,
    ],
  );

  const queueStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId || !window.electronAPI) {
        return;
      }

      const runIdCounter = streamRunIdRef.current;
      if (!runIdCounter) {
        startStream(args);
        return;
      }

      latestUserMessageIdRef.current = args.userMessageId;

      pendingQueuedStartCountRef.current += 1;
      ensureAgentStreamSubscription(runIdCounter);

      const queuedStartChatAttachments = attachmentsForStartChat(
        args.attachments,
      );

      window.electronAPI.agent
        .startChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          userPrompt: args.userPrompt,
          ...(queuedStartChatAttachments?.length
            ? { attachments: queuedStartChatAttachments }
            : {}),
          storageMode,
        })
        .then(({ runId: agentRunId }) => {
          const wasCancelled =
            cancelledStreamRunIdsRef.current.has(runIdCounter);
          if (runIdCounter !== streamRunIdRef.current) {
            if (wasCancelled && window.electronAPI?.agent.cancelChat) {
              window.electronAPI.agent.cancelChat(agentRunId);
              cancelledStreamRunIdsRef.current.delete(runIdCounter);
            }
            return;
          }

          cancelledStreamRunIdsRef.current.delete(runIdCounter);
          queuedRunStartsRef.current.push({
            runId: agentRunId,
            userMessageId: args.userMessageId,
          });
          activateNextQueuedRun();
        })
        .catch((error) => {
          cancelledStreamRunIdsRef.current.delete(runIdCounter);
          if (runIdCounter !== streamRunIdRef.current) {
            return;
          }

          console.error(
            "Failed to queue local agent chat:",
            (error as Error).message,
          );
          showToast({
            title: "Stella couldn't queue this reply",
            description: (error as Error).message || "Please try again.",
            variant: "error",
          });
        })
        .finally(() => {
          pendingQueuedStartCountRef.current = Math.max(
            0,
            pendingQueuedStartCountRef.current - 1,
          );
        });
    },
    [
      activateNextQueuedRun,
      activeConversationId,
      ensureAgentStreamSubscription,
      startStream,
      storageMode,
    ],
  );

  useResumeAgentRun({
    activeConversationId,
    isStreaming,
    refs: {
      streamRunIdRef,
      localRunIdRef,
      localSeqByRunIdRef,
      agentStreamCleanupRef,
    },
    actions: {
      resetStreamingText,
      resetReasoningText,
      resetStreamingState,
      setIsStreaming,
      setPendingUserMessageId,
      handleAgentEvent,
    },
  });

  return {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  };
}
