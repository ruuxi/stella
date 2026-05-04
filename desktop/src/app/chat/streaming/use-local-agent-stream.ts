import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  TASK_COMPLETION_INDICATOR_MS,
  type TaskItem,
} from '@/app/chat/lib/event-transforms'
import { showToast } from '@/ui/toast'
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  isTerminalTaskLifecycleStatus,
  type TaskLifecycleStatus,
} from '../../../../../runtime/contracts/agent-runtime.js'
import {
  useRafStringAccumulator,
  useStreamBuffer,
} from '@/shared/hooks/use-raf-state'
import { useResumeAgentRun } from '../hooks/use-resume-agent-run'
import type {
  AgentResponseTarget,
  AgentStreamEvent,
  SelfModAppliedData,
} from './streaming-types'
import type { AttachmentRef } from './chat-types'
import type { ChatContext } from '@/shared/types/electron'
import { resolveAgentNotReadyToast } from './agent-stream-errors'

type UseLocalAgentStreamOptions = {
  activeConversationId: string | null
  storageMode: 'cloud' | 'local'
}

type StartStreamArgs = {
  userPrompt: string
  selectedText?: string | null
  chatContext?: ChatContext | null
  deviceId?: string
  platform?: string
  timezone?: string
  /** BCP-47 locale for the user's preferred response language. */
  locale?: string
  mode?: string
  messageMetadata?: Record<string, unknown>
  attachments?: AttachmentRef[]
  userMessageEventId?: string
  onStartFailed?: () => void
}

type RunRecord = {
  runId: string
  conversationId: string
  requestId?: string
  userMessageId?: string
  uiVisibility?: 'visible' | 'hidden'
  terminal: boolean
  outcome?: 'completed' | 'error' | 'canceled'
  statusText: string | null
}

type StreamStoreState = {
  runsById: Record<string, RunRecord>
  activeRunIdByConversation: Record<string, string | null>
  tasksByRunId: Record<string, Record<string, TaskItem>>
  requestToRunId: Record<string, string>
}

type ActiveRunSnapshot = {
  runId: string
  conversationId: string
  requestId?: string
  userMessageId?: string
  uiVisibility?: 'visible' | 'hidden'
} | null

type ResumeTaskSnapshot = {
  runId: string
  agentId: string
  agentType?: string
  description?: string
  anchorTurnId?: string
  parentAgentId?: string
  status: TaskLifecycleStatus
  statusText?: string
  reasoningText?: string
  result?: string
  error?: string
}

type StreamStoreAction =
  | {
      type: 'run-started'
      runId: string
      conversationId: string
      requestId?: string
      userMessageId?: string
      uiVisibility?: 'visible' | 'hidden'
    }
  | {
      type: 'run-status'
      runId: string
      statusText: string | null
    }
  | {
      type: 'run-finished'
      runId: string
      conversationId: string
      outcome: 'completed' | 'error' | 'canceled'
    }
  | {
      type: 'task-upsert'
      runId: string
      conversationId: string
      userMessageId?: string
      task: TaskItem
    }
  | {
      type: 'agent-reasoning'
      runId: string
      conversationId: string
      userMessageId?: string
      agentId: string
      chunk: string
    }
  | {
      type: 'task-remove'
      runId: string
      agentId: string
    }
  | {
      type: 'clear-run-tasks'
      runId: string
    }
  | {
      type: 'hydrate-conversation'
      conversationId: string
      activeRun: ActiveRunSnapshot
      tasks: TaskItem[]
    }

const initialStoreState: StreamStoreState = {
  runsById: {},
  activeRunIdByConversation: {},
  tasksByRunId: {},
  requestToRunId: {},
}

function streamStoreReducer(
  state: StreamStoreState,
  action: StreamStoreAction,
): StreamStoreState {
  switch (action.type) {
    case 'run-started': {
      const current = state.runsById[action.runId]
      const nextRun: RunRecord = {
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: action.requestId ?? current?.requestId,
        userMessageId: action.userMessageId ?? current?.userMessageId,
        uiVisibility: action.uiVisibility ?? current?.uiVisibility,
        terminal: false,
        statusText: null,
      }
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
      }
    }
    case 'run-status': {
      const current = state.runsById[action.runId]
      if (!current || current.terminal) {
        return state
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
      }
    }
    case 'run-finished': {
      const current = state.runsById[action.runId]
      const nextRun: RunRecord = {
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: current?.requestId,
        userMessageId: current?.userMessageId,
        terminal: true,
        outcome: action.outcome,
        statusText: null,
      }
      const activeRunId =
        state.activeRunIdByConversation[action.conversationId] ?? null
      const nextTasksByRunId = { ...state.tasksByRunId }
      delete nextTasksByRunId[action.runId]
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: nextRun,
        },
        tasksByRunId: nextTasksByRunId,
        activeRunIdByConversation:
          activeRunId === action.runId
            ? {
                ...state.activeRunIdByConversation,
                [action.conversationId]: null,
              }
            : state.activeRunIdByConversation,
      }
    }
    case 'task-upsert': {
      const runRecord = state.runsById[action.runId]
      const runTasks = state.tasksByRunId[action.runId] ?? {}
      const existing = runTasks[action.task.id]
      const nextDescription =
        action.task.description === 'Task' && existing?.description
          ? existing.description
          : action.task.description
      const nextTask: TaskItem = {
        ...action.task,
        description: nextDescription,
        anchorTurnId: action.task.anchorTurnId ?? existing?.anchorTurnId,
        startedAtMs: existing?.startedAtMs ?? action.task.startedAtMs,
        statusText:
          action.task.status === 'running'
            ? (action.task.statusText ?? existing?.statusText)
            : undefined,
        reasoningText:
          typeof action.task.reasoningText === 'string'
            ? action.task.reasoningText
            : existing?.reasoningText,
        outputPreview:
          action.task.status === 'running'
            ? undefined
            : action.task.outputPreview,
      }
      return {
        ...state,
        runsById: runRecord
          ? state.runsById
          : {
              ...state.runsById,
              [action.runId]: {
                runId: action.runId,
                conversationId: action.conversationId,
                userMessageId: action.userMessageId,
                uiVisibility: 'hidden',
                terminal: false,
                statusText: null,
              },
            },
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: {
            ...runTasks,
            [action.task.id]: nextTask,
          },
        },
      }
    }
    case 'agent-reasoning': {
      const runRecord = state.runsById[action.runId]
      const runTasks = state.tasksByRunId[action.runId] ?? {}
      const existing = runTasks[action.agentId]
      if (!action.chunk) {
        return state
      }
      const nextReasoningText = `${existing?.reasoningText ?? ''}${action.chunk}`
      const storedReasoningText =
        nextReasoningText.length > MAX_AGENT_REASONING_CHARS
          ? nextReasoningText.slice(-MAX_AGENT_REASONING_CHARS)
          : nextReasoningText
      const nowMs = Date.now()
      return {
        ...state,
        runsById: runRecord
          ? state.runsById
          : {
              ...state.runsById,
              [action.runId]: {
                runId: action.runId,
                conversationId: action.conversationId,
                userMessageId: action.userMessageId,
                uiVisibility: 'hidden',
                terminal: false,
                statusText: null,
              },
            },
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: {
            ...runTasks,
            [action.agentId]: {
              ...(existing ?? {
                id: action.agentId,
                description: 'Task',
                agentType: AGENT_IDS.GENERAL,
                status: 'running',
                anchorTurnId: runRecord?.userMessageId,
                startedAtMs: nowMs,
                lastUpdatedAtMs: nowMs,
              }),
              reasoningText: storedReasoningText,
              lastUpdatedAtMs: nowMs,
            },
          },
        },
      }
    }
    case 'task-remove': {
      const runTasks = state.tasksByRunId[action.runId]
      if (!runTasks || !(action.agentId in runTasks)) {
        return state
      }
      const nextRunTasks = { ...runTasks }
      delete nextRunTasks[action.agentId]
      return {
        ...state,
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: nextRunTasks,
        },
      }
    }
    case 'clear-run-tasks': {
      if (!(action.runId in state.tasksByRunId)) {
        return state
      }
      const nextTasksByRunId = { ...state.tasksByRunId }
      delete nextTasksByRunId[action.runId]
      return {
        ...state,
        tasksByRunId: nextTasksByRunId,
      }
    }
    case 'hydrate-conversation': {
      const nextRunsById = { ...state.runsById }
      const nextTasksByRunId = Object.fromEntries(
        Object.entries(state.tasksByRunId).filter(([runId]) => {
          const runRecord = state.runsById[runId]
          return runRecord?.conversationId !== action.conversationId
        }),
      )
      for (const task of action.tasks) {
        // Hydrate tasks always come from resume snapshots which carry runId;
        // skip any oddballs that don't, since they can't be bucketed by run.
        const runId = task.runId
        if (!runId) continue
        nextRunsById[runId] = nextRunsById[runId] ?? {
          runId,
          conversationId: action.conversationId,
          terminal: false,
          statusText: null,
        }
        nextTasksByRunId[runId] = {
          ...(nextTasksByRunId[runId] ?? {}),
          [task.id]: task,
        }
      }
      if (!action.activeRun) {
        return {
          ...state,
          runsById: nextRunsById,
          tasksByRunId: nextTasksByRunId,
          activeRunIdByConversation: {
            ...state.activeRunIdByConversation,
            [action.conversationId]: null,
          },
        }
      }
      const runId = action.activeRun.runId
      const taskMap = {
        ...(nextTasksByRunId[runId] ?? {}),
        ...Object.fromEntries(action.tasks.map((task) => [task.id, task])),
      }
      return {
        ...state,
        runsById: {
          ...nextRunsById,
          [runId]: {
            runId,
            conversationId: action.conversationId,
            requestId: action.activeRun.requestId,
            userMessageId: action.activeRun.userMessageId,
            uiVisibility: action.activeRun.uiVisibility,
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
          ...nextTasksByRunId,
          [runId]: taskMap,
        },
      }
    }
    default:
      return state
  }
}

function attachmentsForStartChat(
  attachments: AttachmentRef[] | undefined,
): { url: string; mimeType?: string }[] | undefined {
  if (!attachments?.length) return undefined
  const mapped = attachments
    .filter(
      (a): a is AttachmentRef & { url: string } =>
        typeof a.url === 'string' && a.url.length > 0,
    )
    .map((a) => {
      const item: { url: string; mimeType?: string } = { url: a.url }
      if (a.mimeType) item.mimeType = a.mimeType
      return item
    })
  return mapped.length ? mapped : undefined
}

const toRunTaskId = (runId: string, agentId: string) => `${runId}:${agentId}`
const MAX_AGENT_REASONING_CHARS = 8_000

export const reconcileTerminalTaskKeysFromResumeTasks = (args: {
  currentKeys: ReadonlySet<string>
  tasks: Array<{
    runId: string
    agentId: string
    status: TaskLifecycleStatus
  }>
}): Set<string> => {
  const nextKeys = new Set(args.currentKeys)
  for (const task of args.tasks) {
    const taskKey = toRunTaskId(task.runId, task.agentId)
    if (isTerminalTaskLifecycleStatus(task.status)) {
      nextKeys.add(taskKey)
    } else {
      nextKeys.delete(taskKey)
    }
  }
  return nextKeys
}

const toTaskFromResumeSnapshot = (
  snapshot: ResumeTaskSnapshot,
  nowMs: number,
): TaskItem => ({
  id: snapshot.agentId,
  runId: snapshot.runId,
  description: snapshot.description ?? 'Task',
  agentType: snapshot.agentType || AGENT_IDS.GENERAL,
  status:
    snapshot.status === 'completed'
      ? 'completed'
      : snapshot.status === 'error'
        ? 'error'
        : snapshot.status === 'canceled'
          ? 'canceled'
          : 'running',
  anchorTurnId: snapshot.anchorTurnId,
  parentAgentId: snapshot.parentAgentId,
  statusText: snapshot.statusText,
  startedAtMs: nowMs,
  completedAtMs:
    snapshot.status === 'completed' ||
    snapshot.status === 'error' ||
    snapshot.status === 'canceled'
      ? nowMs
      : undefined,
  lastUpdatedAtMs: nowMs,
  outputPreview: snapshot.result ?? snapshot.error,
  reasoningText: snapshot.reasoningText,
})

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
}: UseLocalAgentStreamOptions) {
  const [storeState, dispatch] = useReducer(
    streamStoreReducer,
    initialStoreState,
  )
  const [rawStreamingText, appendStreamingDelta, resetStreamingText] =
    useRafStringAccumulator()
  const [rawReasoningText, , resetReasoningText] = useRafStringAccumulator()
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null)
  const [streamingResponseTarget, setStreamingResponseTarget] =
    useState<AgentResponseTarget | null>(null)
  const [selfModMap, setSelfModMap] = useState<
    Record<string, SelfModAppliedData>
  >({})

  const activeConversationIdRef = useRef<string | null>(activeConversationId)
  const activeRunIdByConversationRef = useRef<Record<string, string | null>>(
    storeState.activeRunIdByConversation,
  )
  const lastSeqByConversationRef = useRef(new Map<string, number>())
  const terminalRunIdsRef = useRef(new Set<string>())
  // Tracks per-run agent IDs that have reached a terminal lifecycle state.
  // Mirrors the persisted-event guard in `extractTasksFromEvents` so that
  // late `agent-progress` events arriving after `agent-completed` /
  // `agent-failed` / `agent-canceled` cannot flip a finished task back to
  // "running" — which would otherwise pin a phantom "Working … Task" chip.
  const terminalTaskKeysRef = useRef(new Set<string>())
  const pendingRequestIdsRef = useRef(new Set<string>())
  const startAttemptRef = useRef(0)
  const agentStreamCleanupRef = useRef<(() => void) | null>(null)
  const liveTaskRemovalTimeoutsRef = useRef(new Map<string, number>())
  const pendingReasoningChunksRef = useRef(
    new Map<
      string,
      {
        runId: string
        conversationId: string
        userMessageId?: string
        agentId: string
        chunk: string
      }
    >(),
  )
  const reasoningFrameRef = useRef<number | null>(null)

  const activeRunId = activeConversationId
    ? (storeState.activeRunIdByConversation[activeConversationId] ?? null)
    : null
  const activeRun = activeRunId
    ? (storeState.runsById[activeRunId] ?? null)
    : null
  const isStreaming = Boolean(activeRun && !activeRun.terminal)
  const runtimeStatusText = activeRun?.statusText ?? null

  const streamingText = useStreamBuffer(rawStreamingText, isStreaming)
  const reasoningText = useStreamBuffer(rawReasoningText, isStreaming)

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    activeRunIdByConversationRef.current = storeState.activeRunIdByConversation
  }, [storeState.activeRunIdByConversation])

  const clearScheduledTaskRemoval = useCallback(
    (runId: string, agentId: string) => {
      const key = toRunTaskId(runId, agentId)
      const timeoutId = liveTaskRemovalTimeoutsRef.current.get(key)
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId)
        liveTaskRemovalTimeoutsRef.current.delete(key)
      }
    },
    [],
  )

  const scheduleTaskRemoval = useCallback(
    (runId: string, agentId: string, delayMs: number) => {
      clearScheduledTaskRemoval(runId, agentId)
      const key = toRunTaskId(runId, agentId)
      const timeoutId = window.setTimeout(() => {
        liveTaskRemovalTimeoutsRef.current.delete(key)
        dispatch({
          type: 'task-remove',
          runId,
          agentId,
        })
      }, delayMs)
      liveTaskRemovalTimeoutsRef.current.set(key, timeoutId)
    },
    [clearScheduledTaskRemoval],
  )

  const clearAllScheduledTaskRemovals = useCallback(() => {
    for (const timeoutId of liveTaskRemovalTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId)
    }
    liveTaskRemovalTimeoutsRef.current.clear()
  }, [])

  const flushPendingReasoningChunks = useCallback((onlyKey?: string) => {
    const pending = pendingReasoningChunksRef.current
    const entries = onlyKey
      ? pending.has(onlyKey)
        ? [[onlyKey, pending.get(onlyKey)!] as const]
        : []
      : [...pending.entries()]
    if (entries.length === 0) {
      return
    }

    for (const [key] of entries) {
      pending.delete(key)
    }
    for (const [, entry] of entries) {
      dispatch({
        type: 'agent-reasoning',
        runId: entry.runId,
        conversationId: entry.conversationId,
        userMessageId: entry.userMessageId,
        agentId: entry.agentId,
        chunk: entry.chunk,
      })
    }
  }, [])

  const queueAgentReasoningChunk = useCallback(
    (entry: {
      runId: string
      conversationId: string
      userMessageId?: string
      agentId: string
      chunk: string
    }) => {
      const key = toRunTaskId(entry.runId, entry.agentId)
      const current = pendingReasoningChunksRef.current.get(key)
      pendingReasoningChunksRef.current.set(key, {
        ...entry,
        chunk: `${current?.chunk ?? ''}${entry.chunk}`,
      })

      if (reasoningFrameRef.current !== null) {
        return
      }
      reasoningFrameRef.current = window.requestAnimationFrame(() => {
        reasoningFrameRef.current = null
        flushPendingReasoningChunks()
      })
    },
    [flushPendingReasoningChunks],
  )

  const discardPendingReasoningChunks = useCallback(
    (runId: string, agentId: string) => {
      pendingReasoningChunksRef.current.delete(toRunTaskId(runId, agentId))
    },
    [],
  )

  useEffect(() => {
    return () => {
      if (reasoningFrameRef.current !== null) {
        window.cancelAnimationFrame(reasoningFrameRef.current)
        reasoningFrameRef.current = null
      }
      pendingReasoningChunksRef.current.clear()
    }
  }, [])

  useEffect(
    () => () => {
      clearAllScheduledTaskRemovals()
    },
    [clearAllScheduledTaskRemovals],
  )

  useEffect(
    () => () => {
      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current()
        agentStreamCleanupRef.current = null
      }
    },
    [],
  )

  const resetStreamingState = useCallback(() => {
    resetStreamingText()
    resetReasoningText()
    setPendingUserMessageId(null)
    setStreamingResponseTarget(null)
    if (activeRunId) {
      dispatch({
        type: 'clear-run-tasks',
        runId: activeRunId,
      })
    }
  }, [activeRunId, resetReasoningText, resetStreamingText])

  const handleAgentEvent = useCallback(
    (event: AgentStreamEvent) => {
      const conversationId =
        event.conversationId ?? activeConversationIdRef.current ?? null
      if (!conversationId) {
        return
      }

      const seq = Number.isFinite(event.seq) ? event.seq : 0
      if (seq > 0) {
        const previousSeq =
          lastSeqByConversationRef.current.get(conversationId) ?? 0
        if (seq <= previousSeq) {
          return
        }
        lastSeqByConversationRef.current.set(conversationId, seq)
      }

      if (event.requestId) {
        pendingRequestIdsRef.current.delete(event.requestId)
      }

      const isOrchestratorEvent =
        (event.agentType ?? AGENT_IDS.ORCHESTRATOR) === AGENT_IDS.ORCHESTRATOR
      const activeRunForConversation =
        activeRunIdByConversationRef.current[conversationId] ?? null
      const isPrimaryRun =
        Boolean(activeRunForConversation) &&
        activeRunForConversation === event.runId

      const applyRunFinished = (args: {
        outcome: 'completed' | 'error' | 'canceled'
        reason?: string
      }) => {
        if (terminalRunIdsRef.current.has(event.runId)) {
          return
        }
        terminalRunIdsRef.current.add(event.runId)
        // Drop terminal-task entries scoped to this run so the set doesn't
        // grow unbounded across the session.
        const runIdPrefix = `${event.runId}:`
        for (const key of terminalTaskKeysRef.current) {
          if (key.startsWith(runIdPrefix)) {
            terminalTaskKeysRef.current.delete(key)
          }
        }
        dispatch({
          type: 'run-finished',
          runId: event.runId,
          conversationId,
          outcome: args.outcome,
        })
        if (
          conversationId === activeConversationIdRef.current &&
          args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR
        ) {
          showToast({
            title: 'Something went wrong',
            description: args.reason || event.error || undefined,
            variant: 'error',
          })
        }
        if (args.outcome !== AGENT_RUN_FINISH_OUTCOMES.COMPLETED) {
          resetStreamingText()
          resetReasoningText()
          setPendingUserMessageId(null)
          setStreamingResponseTarget(null)
        }
        if (event.selfModApplied && event.userMessageId) {
          setSelfModMap((previous) => ({
            ...previous,
            [event.userMessageId!]: event.selfModApplied!,
          }))
        }
      }

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.RUN_STARTED: {
          if (event.uiVisibility === 'hidden') {
            break
          }
          terminalRunIdsRef.current.delete(event.runId)
          dispatch({
            type: 'run-started',
            runId: event.runId,
            conversationId,
            requestId: event.requestId,
            userMessageId: event.userMessageId,
            uiVisibility: event.uiVisibility,
          })
          if (conversationId === activeConversationIdRef.current) {
            resetStreamingText()
            resetReasoningText()
            setPendingUserMessageId(
              event.responseTarget && event.responseTarget.type !== 'user_turn'
                ? null
                : (event.userMessageId ?? null),
            )
            setStreamingResponseTarget(event.responseTarget ?? null)
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.STREAM: {
          const isReactivation =
            !isPrimaryRun &&
            isOrchestratorEvent &&
            terminalRunIdsRef.current.has(event.runId)
          if (isReactivation) {
            terminalRunIdsRef.current.delete(event.runId)
            dispatch({
              type: 'run-started',
              runId: event.runId,
              conversationId,
              requestId: event.requestId,
            })
            resetStreamingText()
            resetReasoningText()
            setStreamingResponseTarget(null)
          }
          dispatch({
            type: 'run-status',
            runId: event.runId,
            statusText: null,
          })
          if (
            (isPrimaryRun || isReactivation) &&
            isOrchestratorEvent &&
            event.chunk
          ) {
            setStreamingResponseTarget(event.responseTarget ?? null)
            appendStreamingDelta(event.chunk)
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.STATUS: {
          dispatch({
            type: 'run-status',
            runId: event.runId,
            statusText: event.statusText
              ? event.statusState === 'compacting'
                ? event.statusText || 'Compacting context'
                : event.statusText
              : null,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING:
        case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
        case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED: {
          const runId = event.rootRunId ?? event.runId
          if (!runId || !event.agentId) {
            return
          }
          console.debug('[stella:working-indicator:event]', {
            type: event.type,
            runId,
            agentId: event.agentId,
            description: event.description,
            statusText: event.statusText,
            rootRunId: event.rootRunId,
          })

          // Drop late progress/reasoning events for tasks that already
          // reached a terminal state. Only a fresh AGENT_STARTED may revive
          // a terminal task (mirrors the persisted-event guard in
          // extractTasksFromEvents).
          const taskKey = toRunTaskId(runId, event.agentId)
          const isStarted =
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED
          const isTerminal =
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_FAILED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED
          if (
            terminalTaskKeysRef.current.has(taskKey) &&
            !isStarted &&
            !isTerminal
          ) {
            return
          }
          if (isStarted) {
            terminalTaskKeysRef.current.delete(taskKey)
          }

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING) {
            if (!event.chunk) {
              return
            }
            queueAgentReasoningChunk({
              runId,
              conversationId,
              userMessageId: event.userMessageId,
              agentId: event.agentId,
              chunk: event.chunk,
            })
            break
          }

          clearScheduledTaskRemoval(runId, event.agentId)
          const nowMs = Date.now()
          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_FAILED) {
            discardPendingReasoningChunks(runId, event.agentId)
            terminalTaskKeysRef.current.add(taskKey)
            dispatch({
              type: 'task-remove',
              runId,
              agentId: event.agentId,
            })
            return
          }
          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED) {
            discardPendingReasoningChunks(runId, event.agentId)
            terminalTaskKeysRef.current.add(taskKey)
            dispatch({
              type: 'task-remove',
              runId,
              agentId: event.agentId,
            })
            return
          }

          flushPendingReasoningChunks(taskKey)
          dispatch({
            type: 'task-upsert',
            runId,
            conversationId,
            userMessageId: event.userMessageId,
            task: {
              id: event.agentId,
              description: event.description ?? 'Task',
              agentType: event.agentType || AGENT_IDS.GENERAL,
              status:
                event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED
                  ? 'completed'
                  : 'running',
              anchorTurnId: event.userMessageId,
              parentAgentId: event.parentAgentId,
              statusText: event.statusText,
              reasoningText:
                event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED
                  ? ''
                  : undefined,
              startedAtMs: nowMs,
              completedAtMs:
                event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED
                  ? nowMs
                  : undefined,
              lastUpdatedAtMs: nowMs,
              outputPreview: event.result,
            },
          })

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED) {
            terminalTaskKeysRef.current.add(taskKey)
            scheduleTaskRemoval(
              runId,
              event.agentId,
              TASK_COMPLETION_INDICATOR_MS,
            )
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED: {
          applyRunFinished({
            outcome: event.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: event.reason ?? event.error,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.TOOL_START:
        case AGENT_STREAM_EVENT_TYPES.TOOL_END:
        default:
          break
      }
    },
    [
      appendStreamingDelta,
      clearScheduledTaskRemoval,
      discardPendingReasoningChunks,
      flushPendingReasoningChunks,
      queueAgentReasoningChunk,
      resetReasoningText,
      resetStreamingText,
      scheduleTaskRemoval,
    ],
  )

  const ensureAgentStreamSubscription = useCallback(() => {
    if (!window.electronAPI?.agent.onStream || agentStreamCleanupRef.current) {
      return
    }
    agentStreamCleanupRef.current = window.electronAPI.agent.onStream(
      (event) => {
        handleAgentEvent(event)
      },
    )
  }, [handleAgentEvent])

  const applyResumeSnapshot = useCallback(
    (args: {
      conversationId: string
      activeRun: ActiveRunSnapshot
      tasks: ResumeTaskSnapshot[]
    }) => {
      const nowMs = Date.now()
      terminalTaskKeysRef.current = reconcileTerminalTaskKeysFromResumeTasks({
        currentKeys: terminalTaskKeysRef.current,
        tasks: args.tasks,
      })
      const taskItems = args.tasks.map((task) =>
        toTaskFromResumeSnapshot(task, nowMs),
      )
      dispatch({
        type: 'hydrate-conversation',
        conversationId: args.conversationId,
        activeRun:
          args.activeRun?.uiVisibility === 'hidden' ? null : args.activeRun,
        tasks: taskItems,
      })
      if (args.conversationId === activeConversationIdRef.current) {
        setPendingUserMessageId(
          args.activeRun?.uiVisibility === 'hidden'
            ? null
            : (args.activeRun?.userMessageId ?? null),
        )
        setStreamingResponseTarget(null)
      }
      for (const task of args.tasks) {
        if (task.status === 'completed') {
          scheduleTaskRemoval(
            task.runId,
            task.agentId,
            TASK_COMPLETION_INDICATOR_MS,
          )
        }
      }
    },
    [scheduleTaskRemoval],
  )

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
  })

  useEffect(() => {
    resetStreamingText()
    resetReasoningText()
    setStreamingResponseTarget(null)
    const timeoutId = window.setTimeout(() => {
      setPendingUserMessageId(null)
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [activeConversationId, resetReasoningText, resetStreamingText])

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId || !window.electronAPI) {
        args.onStartFailed?.()
        return
      }

      ensureAgentStreamSubscription()

      const attemptId = ++startAttemptRef.current
      const startChatAttachments = attachmentsForStartChat(args.attachments)

      void (async () => {
        if (attemptId !== startAttemptRef.current) return

        const { requestId } = await window.electronAPI!.agent.startChat({
          conversationId: activeConversationId,
          userPrompt: args.userPrompt,
          ...(typeof args.selectedText !== 'undefined'
            ? { selectedText: args.selectedText }
            : {}),
          ...(typeof args.chatContext !== 'undefined'
            ? { chatContext: args.chatContext }
            : {}),
          deviceId: args.deviceId,
          platform: args.platform,
          timezone: args.timezone,
          ...(args.locale ? { locale: args.locale } : {}),
          mode: args.mode,
          ...(args.messageMetadata
            ? { messageMetadata: args.messageMetadata }
            : {}),
          ...(startChatAttachments?.length
            ? { attachments: startChatAttachments }
            : {}),
          ...(args.userMessageEventId
            ? { userMessageEventId: args.userMessageEventId }
            : {}),
          storageMode,
        })
        pendingRequestIdsRef.current.add(requestId)
      })()
        .catch((error) => {
          console.error(
            'Failed to start local agent chat:',
            (error as Error).message,
          )
          const toast = resolveAgentNotReadyToast(
            (error as Error).message || null,
          )
          showToast({
            title: toast.title,
            description:
              toast.description || (error as Error).message || 'Please try again.',
            variant: 'error',
          })
          args.onStartFailed?.()
        })
    },
    [
      activeConversationId,
      ensureAgentStreamSubscription,
      storageMode,
    ],
  )

  const queueStream = useCallback(
    (args: StartStreamArgs) => {
      startStream(args)
    },
    [startStream],
  )

  const cancelCurrentStream = useCallback(() => {
    if (!activeRunId || !window.electronAPI?.agent.cancelChat) {
      return
    }
    window.electronAPI.agent.cancelChat(activeRunId)
  }, [activeRunId])

  const conversationTasks = activeConversationId
    ? Object.entries(storeState.tasksByRunId)
        .filter(
          ([runId]) =>
            storeState.runsById[runId]?.conversationId === activeConversationId,
        )
        .flatMap(([runId, taskMap]) => {
          const anchorTurnId = storeState.runsById[runId]?.userMessageId
          return Object.values(taskMap).map((task) => ({
            ...task,
            anchorTurnId: task.anchorTurnId ?? anchorTurnId ?? undefined,
          }))
        })
    : []
  const liveTasks = conversationTasks.sort(
    (a, b) => a.startedAtMs - b.startedAtMs,
  )

  return {
    liveTasks,
    runtimeStatusText,
    streamingText,
    reasoningText,
    streamingResponseTarget,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  }
}
