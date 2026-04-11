import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  TASK_COMPLETION_INDICATOR_MS,
  type TaskItem,
} from "@/app/chat/lib/event-transforms";
import { showToast } from "@/ui/toast";
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@/shared/contracts/agent-runtime";
import {
  useRafStringAccumulator,
  useStreamBuffer,
} from "@/shared/hooks/use-raf-state";
import { useResumeAgentRun } from "../hooks/use-resume-agent-run";
import type { AgentStreamEvent, SelfModAppliedData } from "./streaming-types";
import type { AttachmentRef } from "./chat-types";
import type { ChatContext } from "@/shared/types/electron";
import {
  getAgentHealthReason,
  resolveAgentNotReadyToast,
  trySyncHostToken,
} from "./agent-stream-errors";

type UseLocalAgentStreamOptions = {
  activeConversationId: string | null;
  storageMode: "cloud" | "local";
};

type StartStreamArgs = {
  userPrompt: string;
  selectedText?: string | null;
  chatContext?: ChatContext | null;
  deviceId?: string;
  platform?: string;
  timezone?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: AttachmentRef[];
};

type RunRecord = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  terminal: boolean;
  outcome?: "completed" | "error" | "canceled";
  statusText: string | null;
};

type StreamStoreState = {
  runsById: Record<string, RunRecord>;
  activeRunIdByConversation: Record<string, string | null>;
  tasksByRunId: Record<string, Record<string, TaskItem>>;
  requestToRunId: Record<string, string>;
};

type ActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
} | null;

type ResumeTaskSnapshot = {
  runId: string;
  taskId: string;
  agentType?: string;
  description?: string;
  parentTaskId?: string;
  status: "running" | "completed" | "error" | "canceled";
  statusText?: string;
  result?: string;
  error?: string;
};

type StreamStoreAction =
  | {
      type: "run-started";
      runId: string;
      conversationId: string;
      requestId?: string;
      userMessageId?: string;
    }
  | {
      type: "run-status";
      runId: string;
      statusText: string | null;
    }
  | {
      type: "run-finished";
      runId: string;
      conversationId: string;
      outcome: "completed" | "error" | "canceled";
    }
  | {
      type: "task-upsert";
      runId: string;
      task: TaskItem;
    }
  | {
      type: "task-remove";
      runId: string;
      taskId: string;
    }
  | {
      type: "clear-run-tasks";
      runId: string;
    }
  | {
      type: "hydrate-conversation";
      conversationId: string;
      activeRun: ActiveRunSnapshot;
      tasks: TaskItem[];
    };

const initialStoreState: StreamStoreState = {
  runsById: {},
  activeRunIdByConversation: {},
  tasksByRunId: {},
  requestToRunId: {},
};

function streamStoreReducer(
  state: StreamStoreState,
  action: StreamStoreAction,
): StreamStoreState {
  switch (action.type) {
    case "run-started": {
      const current = state.runsById[action.runId];
      const nextRun: RunRecord = {
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: action.requestId ?? current?.requestId,
        userMessageId: action.userMessageId ?? current?.userMessageId,
        terminal: false,
        statusText: null,
      };
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: nextRun,
        },
        activeRunIdByConversation: {
          ...state.activeRunIdByConversation,
          [action.conversationId]: action.runId,
        },
        requestToRunId: action.requestId
          ? {
              ...state.requestToRunId,
              [action.requestId]: action.runId,
            }
          : state.requestToRunId,
      };
    }
    case "run-status": {
      const current = state.runsById[action.runId];
      if (!current || current.terminal) {
        return state;
      }
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            statusText: action.statusText,
          },
        },
      };
    }
    case "run-finished": {
      const current = state.runsById[action.runId];
      const nextRun: RunRecord = {
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: current?.requestId,
        userMessageId: current?.userMessageId,
        terminal: true,
        outcome: action.outcome,
        statusText: null,
      };
      const activeRunId =
        state.activeRunIdByConversation[action.conversationId] ?? null;
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: nextRun,
        },
        activeRunIdByConversation:
          activeRunId === action.runId
            ? {
                ...state.activeRunIdByConversation,
                [action.conversationId]: null,
              }
            : state.activeRunIdByConversation,
      };
    }
    case "task-upsert": {
      const runTasks = state.tasksByRunId[action.runId] ?? {};
      const existing = runTasks[action.task.id];
      const nextTask: TaskItem = {
        ...action.task,
        startedAtMs: existing?.startedAtMs ?? action.task.startedAtMs,
        statusText: action.task.statusText ?? existing?.statusText,
        outputPreview: action.task.outputPreview ?? existing?.outputPreview,
      };
      return {
        ...state,
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: {
            ...runTasks,
            [action.task.id]: nextTask,
          },
        },
      };
    }
    case "task-remove": {
      const runTasks = state.tasksByRunId[action.runId];
      if (!runTasks || !(action.taskId in runTasks)) {
        return state;
      }
      const nextRunTasks = { ...runTasks };
      delete nextRunTasks[action.taskId];
      return {
        ...state,
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: nextRunTasks,
        },
      };
    }
    case "clear-run-tasks": {
      if (!(action.runId in state.tasksByRunId)) {
        return state;
      }
      const nextTasksByRunId = { ...state.tasksByRunId };
      delete nextTasksByRunId[action.runId];
      return {
        ...state,
        tasksByRunId: nextTasksByRunId,
      };
    }
    case "hydrate-conversation": {
      if (!action.activeRun) {
        return {
          ...state,
          activeRunIdByConversation: {
            ...state.activeRunIdByConversation,
            [action.conversationId]: null,
          },
        };
      }
      const runId = action.activeRun.runId;
      const taskMap = Object.fromEntries(
        action.tasks.map((task) => [task.id, task]),
      );
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [runId]: {
            runId,
            conversationId: action.conversationId,
            requestId: action.activeRun.requestId,
            userMessageId: action.activeRun.userMessageId,
            terminal: false,
            statusText: null,
          },
        },
        activeRunIdByConversation: {
          ...state.activeRunIdByConversation,
          [action.conversationId]: runId,
        },
        requestToRunId: action.activeRun.requestId
          ? {
              ...state.requestToRunId,
              [action.activeRun.requestId]: runId,
            }
          : state.requestToRunId,
        tasksByRunId: {
          ...state.tasksByRunId,
          [runId]: taskMap,
        },
      };
    }
    default:
      return state;
  }
}

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

const toRunTaskId = (runId: string, taskId: string) => `${runId}:${taskId}`;

const isTokenSyncIssue = (reason: string | null) =>
  Boolean(reason && reason.toLowerCase().match(/token|auth/));

const toTaskFromResumeSnapshot = (
  snapshot: ResumeTaskSnapshot,
  nowMs: number,
): TaskItem => ({
  id: snapshot.taskId,
  description: snapshot.description ?? "Task",
  agentType: snapshot.agentType ?? "task",
  status:
    snapshot.status === "completed"
      ? "completed"
      : snapshot.status === "error"
        ? "error"
        : snapshot.status === "canceled"
          ? "canceled"
          : "running",
  parentTaskId: snapshot.parentTaskId,
  statusText: snapshot.statusText,
  startedAtMs: nowMs,
  completedAtMs:
    snapshot.status === "completed" || snapshot.status === "error" || snapshot.status === "canceled"
      ? nowMs
      : undefined,
  lastUpdatedAtMs: nowMs,
  outputPreview: snapshot.result ?? snapshot.error,
});

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
}: UseLocalAgentStreamOptions) {
  const [storeState, dispatch] = useReducer(streamStoreReducer, initialStoreState);
  const [rawStreamingText, appendStreamingDelta, resetStreamingText] =
    useRafStringAccumulator();
  const [rawReasoningText, , resetReasoningText] = useRafStringAccumulator();
  const [subagentStreamingText, appendSubagentDelta, resetSubagentText] =
    useRafStringAccumulator();
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  );
  const [selfModMap, setSelfModMap] = useState<Record<string, SelfModAppliedData>>(
    {},
  );

  const activeConversationIdRef = useRef<string | null>(activeConversationId);
  const activeRunIdByConversationRef = useRef<Record<string, string | null>>(
    storeState.activeRunIdByConversation,
  );
  const lastSeqByConversationRef = useRef(new Map<string, number>());
  const lastSeqByEventScopeRef = useRef(new Map<string, number>());
  const terminalRunIdsRef = useRef(new Set<string>());
  const pendingRequestIdsRef = useRef(new Set<string>());
  const startAttemptRef = useRef(0);
  const agentStreamCleanupRef = useRef<(() => void) | null>(null);
  const liveTaskRemovalTimeoutsRef = useRef(new Map<string, number>());

  const activeRunId =
    activeConversationId
      ? storeState.activeRunIdByConversation[activeConversationId] ?? null
      : null;
  const activeRun = activeRunId ? storeState.runsById[activeRunId] ?? null : null;
  const isStreaming = Boolean(activeRun && !activeRun.terminal);
  const runtimeStatusText = activeRun?.statusText ?? null;

  const streamingText = useStreamBuffer(rawStreamingText, isStreaming);
  const reasoningText = useStreamBuffer(rawReasoningText, isStreaming);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activeRunIdByConversationRef.current = storeState.activeRunIdByConversation;
  }, [storeState.activeRunIdByConversation]);

  const clearScheduledTaskRemoval = useCallback((runId: string, taskId: string) => {
    const key = toRunTaskId(runId, taskId);
    const timeoutId = liveTaskRemovalTimeoutsRef.current.get(key);
    if (typeof timeoutId === "number") {
      window.clearTimeout(timeoutId);
      liveTaskRemovalTimeoutsRef.current.delete(key);
    }
  }, []);

  const scheduleTaskRemoval = useCallback(
    (runId: string, taskId: string, delayMs: number) => {
      clearScheduledTaskRemoval(runId, taskId);
      const key = toRunTaskId(runId, taskId);
      const timeoutId = window.setTimeout(() => {
        liveTaskRemovalTimeoutsRef.current.delete(key);
        dispatch({
          type: "task-remove",
          runId,
          taskId,
        });
      }, delayMs);
      liveTaskRemovalTimeoutsRef.current.set(key, timeoutId);
    },
    [clearScheduledTaskRemoval],
  );

  const clearAllScheduledTaskRemovals = useCallback(() => {
    for (const timeoutId of liveTaskRemovalTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId);
    }
    liveTaskRemovalTimeoutsRef.current.clear();
  }, []);

  useEffect(
    () => () => {
      clearAllScheduledTaskRemovals();
    },
    [clearAllScheduledTaskRemovals],
  );

  useEffect(
    () => () => {
      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current();
        agentStreamCleanupRef.current = null;
      }
    },
    [],
  );

  const resetStreamingState = useCallback(() => {
    resetStreamingText();
    resetReasoningText();
    resetSubagentText();
    setPendingUserMessageId(null);
    if (activeRunId) {
      dispatch({
        type: "clear-run-tasks",
        runId: activeRunId,
      });
    }
  }, [activeRunId, resetReasoningText, resetStreamingText, resetSubagentText]);

  const handleAgentEvent = useCallback(
    (event: AgentStreamEvent) => {
      const conversationId =
        event.conversationId ?? activeConversationIdRef.current ?? null;
      if (!conversationId) {
        return;
      }

      const seq = Number.isFinite(event.seq) ? event.seq : 0;
      if (seq > 0) {
        const scopeKey = `${conversationId}:${event.runId || "conversation"}`;
        const previousSeq =
          lastSeqByEventScopeRef.current.get(scopeKey) ?? 0;
        if (seq <= previousSeq) {
          return;
        }
        lastSeqByEventScopeRef.current.set(scopeKey, seq);
        const previousConversationSeq =
          lastSeqByConversationRef.current.get(conversationId) ?? 0;
        if (seq > previousConversationSeq) {
          lastSeqByConversationRef.current.set(conversationId, seq);
        }
      }

      if (event.requestId) {
        pendingRequestIdsRef.current.delete(event.requestId);
      }

      const isOrchestratorEvent =
        (event.agentType ?? AGENT_IDS.ORCHESTRATOR) === AGENT_IDS.ORCHESTRATOR;
      const activeRunForConversation =
        activeRunIdByConversationRef.current[conversationId] ?? null;
      const isPrimaryRun =
        Boolean(activeRunForConversation) && activeRunForConversation === event.runId;

      const applyRunFinished = (args: {
        outcome: "completed" | "error" | "canceled";
        reason?: string;
      }) => {
        if (terminalRunIdsRef.current.has(event.runId)) {
          return;
        }
        terminalRunIdsRef.current.add(event.runId);
        dispatch({
          type: "run-finished",
          runId: event.runId,
          conversationId,
          outcome: args.outcome,
        });
        if (
          conversationId === activeConversationIdRef.current
          && args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR
        ) {
          showToast({
            title: "Something went wrong",
            description: args.reason || event.error || undefined,
            variant: "error",
          });
        }
        if (args.outcome !== AGENT_RUN_FINISH_OUTCOMES.COMPLETED) {
          resetStreamingText();
          resetReasoningText();
          resetSubagentText();
          setPendingUserMessageId(null);
        }
        if (event.selfModApplied && event.userMessageId) {
          setSelfModMap((previous) => ({
            ...previous,
            [event.userMessageId!]: event.selfModApplied!,
          }));
        }
      };

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.RUN_STARTED: {
          terminalRunIdsRef.current.delete(event.runId);
          dispatch({
            type: "run-started",
            runId: event.runId,
            conversationId,
            requestId: event.requestId,
            userMessageId: event.userMessageId,
          });
          if (conversationId === activeConversationIdRef.current) {
            resetStreamingText();
            resetReasoningText();
            resetSubagentText();
            setPendingUserMessageId(event.userMessageId ?? null);
          }
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.STREAM: {
          if (isPrimaryRun && isOrchestratorEvent && event.chunk && event.kind !== "reasoning") {
            appendStreamingDelta(event.chunk);
          }
          if (!isOrchestratorEvent && event.chunk && event.kind === "reasoning") {
            appendSubagentDelta(event.chunk);
          }
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.STATUS: {
          dispatch({
            type: "run-status",
            runId: event.runId,
            statusText:
              event.statusState === "compacting"
                ? event.statusText || "Compacting context"
                : null,
          });
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.TASK_STARTED:
        case AGENT_STREAM_EVENT_TYPES.TASK_PROGRESS:
        case AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED:
        case AGENT_STREAM_EVENT_TYPES.TASK_FAILED:
        case AGENT_STREAM_EVENT_TYPES.TASK_CANCELED: {
          const runId = event.rootRunId ?? event.runId;
          if (!runId || !event.taskId) {
            return;
          }
          clearScheduledTaskRemoval(runId, event.taskId);
          const nowMs = Date.now();
          if (event.type === AGENT_STREAM_EVENT_TYPES.TASK_FAILED) {
            dispatch({
              type: "task-remove",
              runId,
              taskId: event.taskId,
            });
            return;
          }
          if (event.type === AGENT_STREAM_EVENT_TYPES.TASK_CANCELED) {
            dispatch({
              type: "task-remove",
              runId,
              taskId: event.taskId,
            });
            return;
          }

          dispatch({
            type: "task-upsert",
            runId,
            task: {
              id: event.taskId,
              description: event.description ?? "Task",
              agentType: event.agentType ?? "task",
              status:
                event.type === AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED
                  ? "completed"
                  : "running",
              parentTaskId: event.parentTaskId,
              statusText: event.statusText,
              startedAtMs: nowMs,
              completedAtMs:
                event.type === AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED
                  ? nowMs
                  : undefined,
              lastUpdatedAtMs: nowMs,
              outputPreview: event.result,
            },
          });

          if (event.type === AGENT_STREAM_EVENT_TYPES.TASK_COMPLETED) {
            scheduleTaskRemoval(runId, event.taskId, TASK_COMPLETION_INDICATOR_MS);
          }
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED: {
          applyRunFinished({
            outcome: event.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: event.reason ?? event.error,
          });
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.ERROR: {
          applyRunFinished({
            outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: event.error,
          });
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.END: {
          applyRunFinished({
            outcome: AGENT_RUN_FINISH_OUTCOMES.COMPLETED,
          });
          break;
        }
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
        default:
          break;
      }
    },
    [
      appendStreamingDelta,
      appendSubagentDelta,
      clearScheduledTaskRemoval,
      resetReasoningText,
      resetStreamingText,
      resetSubagentText,
      scheduleTaskRemoval,
    ],
  );

  const ensureAgentStreamSubscription = useCallback(() => {
    if (!window.electronAPI?.agent.onStream || agentStreamCleanupRef.current) {
      return;
    }
    agentStreamCleanupRef.current = window.electronAPI.agent.onStream((event) => {
      handleAgentEvent(event);
    });
  }, [handleAgentEvent]);

  const applyResumeSnapshot = useCallback(
    (args: {
      conversationId: string;
      activeRun: ActiveRunSnapshot;
      tasks: ResumeTaskSnapshot[];
    }) => {
      const nowMs = Date.now();
      const taskItems = args.tasks.map((task) => toTaskFromResumeSnapshot(task, nowMs));
      dispatch({
        type: "hydrate-conversation",
        conversationId: args.conversationId,
        activeRun: args.activeRun,
        tasks: taskItems,
      });
      if (args.conversationId === activeConversationIdRef.current) {
        setPendingUserMessageId(args.activeRun?.userMessageId ?? null);
      }
      for (const task of args.tasks) {
        if (task.status === "completed") {
          scheduleTaskRemoval(
            task.runId,
            task.taskId,
            TASK_COMPLETION_INDICATOR_MS,
          );
        }
      }
    },
    [scheduleTaskRemoval],
  );

  useResumeAgentRun({
    activeConversationId,
    refs: {
      lastSeqByConversationRef,
    },
    actions: {
      ensureAgentStreamSubscription,
      applyResumeSnapshot,
      handleAgentEvent,
    },
  });

  useEffect(() => {
    resetStreamingText();
    resetReasoningText();
    setPendingUserMessageId(null);
  }, [activeConversationId, resetReasoningText, resetStreamingText]);

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId || !window.electronAPI) {
        return;
      }

      ensureAgentStreamSubscription();

      if (!window.electronAPI.agent.healthCheck) {
        showToast({ title: "Stella agent is not running", variant: "error" });
        return;
      }

      const attemptId = ++startAttemptRef.current;
      const startChatAttachments = attachmentsForStartChat(args.attachments);

      void window.electronAPI.agent
        .healthCheck()
        .then(async (health) => {
          if (attemptId !== startAttemptRef.current) return;

          let nextHealth = health;
          let reason = getAgentHealthReason(nextHealth);

          if (!nextHealth?.ready && isTokenSyncIssue(reason)) {
            const synced = await trySyncHostToken();
            if (attemptId !== startAttemptRef.current) return;

            if (synced && window.electronAPI?.agent.healthCheck) {
              nextHealth = await window.electronAPI.agent.healthCheck();
              if (attemptId !== startAttemptRef.current) return;
              reason = getAgentHealthReason(nextHealth);
            }
          }

          if (!nextHealth?.ready && isTokenSyncIssue(reason)) {
            const toast = resolveAgentNotReadyToast(reason);
            showToast({
              title: toast.title,
              description: toast.description,
              variant: "error",
            });
            return;
          }

          const { requestId } = await window.electronAPI!.agent.startChat({
            conversationId: activeConversationId,
            userPrompt: args.userPrompt,
            ...(typeof args.selectedText !== "undefined"
              ? { selectedText: args.selectedText }
              : {}),
            ...(typeof args.chatContext !== "undefined"
              ? { chatContext: args.chatContext }
              : {}),
            deviceId: args.deviceId,
            platform: args.platform,
            timezone: args.timezone,
            mode: args.mode,
            ...(args.messageMetadata
              ? { messageMetadata: args.messageMetadata }
              : {}),
            ...(startChatAttachments?.length
              ? { attachments: startChatAttachments }
              : {}),
            storageMode,
          });
          pendingRequestIdsRef.current.add(requestId);
        })
        .catch((error) => {
          console.error("Failed to start local agent chat:", (error as Error).message);
          showToast({
            title: "Stella couldn't start this reply",
            description: (error as Error).message || "Please try again.",
            variant: "error",
          });
        });
    },
    [activeConversationId, ensureAgentStreamSubscription, storageMode],
  );

  const queueStream = useCallback(
    (args: StartStreamArgs) => {
      startStream(args);
    },
    [startStream],
  );

  const cancelCurrentStream = useCallback(() => {
    if (!activeRunId || !window.electronAPI?.agent.cancelChat) {
      return;
    }
    window.electronAPI.agent.cancelChat(activeRunId);
  }, [activeRunId]);

  const activeRunTasks = activeRunId
    ? storeState.tasksByRunId[activeRunId] ?? {}
    : {};
  const liveTasks = Object.values(activeRunTasks).sort(
    (a, b) => a.startedAtMs - b.startedAtMs,
  );

  return {
    liveTasks,
    runtimeStatusText,
    streamingText,
    reasoningText,
    subagentStreamingText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  };
}
