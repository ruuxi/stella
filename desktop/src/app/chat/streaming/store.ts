/**
 * Pure reducer + types for the local agent stream.
 *
 * All side-effecting concerns (timers, IPC subscriptions, rAF batching,
 * React state) live in the surrounding hooks; this module is a plain
 * data transition layer so the same shapes are usable from tests
 * without a React renderer.
 */
import {
  isGenericTaskDescription,
  normalizeTaskDisplayStatusText,
  type TaskItem,
} from '@/app/chat/lib/event-transforms'
import {
  AGENT_IDS,
  isTerminalTaskLifecycleStatus,
  type TaskLifecycleStatus,
} from '../../../../../runtime/contracts/agent-runtime.js'
import type { AttachmentRef } from './chat-types'

export type RunRecord = {
  runId: string
  conversationId: string
  requestId?: string
  userMessageId?: string
  uiVisibility?: 'visible' | 'hidden'
  terminal: boolean
  outcome?: 'completed' | 'error' | 'canceled'
  statusText: string | null
}

export type StreamStoreState = {
  runsById: Record<string, RunRecord>
  activeRunIdByConversation: Record<string, string | null>
  tasksByRunId: Record<string, Record<string, TaskItem>>
  requestToRunId: Record<string, string>
}

export type ActiveRunSnapshot = {
  runId: string
  conversationId: string
  requestId?: string
  userMessageId?: string
  uiVisibility?: 'visible' | 'hidden'
} | null

export type ResumeTaskSnapshot = {
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

export type StreamStoreAction =
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

export const initialStoreState: StreamStoreState = {
  runsById: {},
  activeRunIdByConversation: {},
  tasksByRunId: {},
  requestToRunId: {},
}

export const MAX_AGENT_REASONING_CHARS = 8_000

export const toRunTaskId = (runId: string, agentId: string) =>
  `${runId}:${agentId}`

export function streamStoreReducer(
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
            ? (normalizeTaskDisplayStatusText(action.task.statusText) ??
              normalizeTaskDisplayStatusText(existing?.statusText) ??
              (isGenericTaskDescription(nextDescription)
                ? undefined
                : nextDescription))
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

export function attachmentsForStartChat(
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

export const toTaskFromResumeSnapshot = (
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
