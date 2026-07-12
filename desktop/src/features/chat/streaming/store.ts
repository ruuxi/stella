/**
 * Pure reducer + types for the local agent stream.
 *
 * All side-effecting concerns (timers, IPC subscriptions, rAF batching,
 * React state) live in the surrounding hooks; this module is a plain
 * data transition layer so the same shapes are usable from tests
 * without a React renderer.
 */
import {
  fallbackTaskDescription,
  isFallbackTaskDescription,
  isGenericTaskDescription,
  normalizeTaskDisplayStatusText,
  type TaskItem,
} from '@/features/chat/lib/event-transforms'
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
  hasToolActivity: boolean
  /**
   * `true` while the orchestrator is actively emitting visible answer
   * text. Set on each visible STREAM chunk; reset when a tool starts (the
   * model has stopped talking to do work) and on run start. Drives the
   * inline working indicator's "Thinking → gone" handoff. Tracked at the
   * run level (not derived from the overlay array) so reasoning gaps
   * *after* an interim/preamble message still show the indicator, and so
   * runs without a user-message anchor (proactive / non-`user_turn`) get
   * the same handoff even though they never create a streaming overlay.
   */
  isStreamingText: boolean
  /** Rejects any out-of-order response marker for a finalized preamble. */
  pendingToolAfterPreamble: boolean
  activeToolCalls: Record<
    string,
    {
      toolName: string
      statusText: string | null
    }
  >
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
  groupKey?: string
  groupLabel?: string
  // Real lifecycle timestamps stamped at event receipt in the main process.
  // Optional only for snapshots persisted before these fields existed.
  startedAtMs?: number
  completedAtMs?: number
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
      type: 'mark-streaming-text'
      runId: string
    }
  | {
      type: 'assistant-message-boundary'
      runId: string
      /**
       * True when the message that just finalized ends with a tool call
       * (an interim preamble, not the run's final answer). Re-arms the
       * working indicator by clearing `isStreamingText` at the boundary so
       * it stays up across the gap until the tool starts — rather than
       * lingering dismissed over the visible preamble text.
       */
      followedByToolCall?: boolean
    }
  | {
      type: 'tool-start'
      runId: string
      conversationId: string
      toolCallId?: string
      toolName?: string
      statusText?: string | null
    }
  | {
      type: 'tool-end'
      runId: string
      toolCallId?: string
      toolName?: string
    }
  | {
      type: 'tool-activity-observed'
      runId: string
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
      description?: string
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
      type: 'clear-conversation-tasks'
      conversationId: string
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

const toToolCallKey = (args: {
  runId: string
  toolCallId?: string
  toolName?: string
}) => {
  const callId = args.toolCallId?.trim()
  if (callId) return callId
  const toolName = args.toolName?.trim()
  if (toolName) return `${args.runId}:${toolName}`
  return `${args.runId}:tool`
}

/**
 * Resolve which active tool-call a `tool-end` refers to, tolerant of the
 * runtime keying the end event differently from its start (e.g. a
 * `toolCallId` on start but only a `toolName` on end). A `tool-end` whose
 * exact key is missing must still clear the in-flight tool — otherwise a
 * phantom entry pins `isToolActive` true and the working indicator stays
 * stuck on a tool label until the run finishes. Returns `null` only when
 * nothing can be safely matched (so concurrent tools never clear the wrong
 * entry).
 */
const resolveToolEndKey = (
  activeToolCalls: Record<string, { toolName: string; statusText: string | null }>,
  action: { runId: string; toolCallId?: string; toolName?: string },
): string | null => {
  const exact = toToolCallKey(action)
  if (exact in activeToolCalls) return exact
  const callId = action.toolCallId?.trim()
  if (callId && callId in activeToolCalls) return callId
  const toolName = action.toolName?.trim()
  if (toolName) {
    const nameKey = `${action.runId}:${toolName}`
    if (nameKey in activeToolCalls) return nameKey
    const matchingByName = Object.keys(activeToolCalls).filter(
      (key) => activeToolCalls[key]?.toolName === toolName,
    )
    const lastMatch = matchingByName.at(-1)
    if (lastMatch) return lastMatch
  }
  const keys = Object.keys(activeToolCalls)
  // With a single tool in flight, an unresolved end unambiguously closes it.
  if (keys.length === 1) return keys[0]!
  return null
}

const createEmptyRunRecord = (args: {
  runId: string
  conversationId: string
  requestId?: string | undefined
  userMessageId?: string | undefined
  uiVisibility?: 'visible' | 'hidden' | undefined
  terminal?: boolean
  outcome?: 'completed' | 'error' | 'canceled' | undefined
  statusText?: string | null
}): RunRecord => ({
  runId: args.runId,
  conversationId: args.conversationId,
  ...(args.requestId ? { requestId: args.requestId } : {}),
  ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
  ...(args.uiVisibility ? { uiVisibility: args.uiVisibility } : {}),
  terminal: args.terminal ?? false,
  ...(args.outcome ? { outcome: args.outcome } : {}),
  statusText: args.statusText ?? null,
  hasToolActivity: false,
  isStreamingText: false,
  pendingToolAfterPreamble: false,
  activeToolCalls: {},
})

export function streamStoreReducer(
  state: StreamStoreState,
  action: StreamStoreAction,
): StreamStoreState {
  switch (action.type) {
    case 'run-started': {
      const current = state.runsById[action.runId]
      const nextRun: RunRecord = createEmptyRunRecord({
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: action.requestId ?? current?.requestId,
        userMessageId: action.userMessageId ?? current?.userMessageId,
        uiVisibility: action.uiVisibility ?? current?.uiVisibility,
      })
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
    case 'mark-streaming-text': {
      const current = state.runsById[action.runId]
      if (
        !current ||
        current.terminal ||
        current.isStreamingText ||
        // A preamble→tool boundary just fired: this marker belongs to the
        // finalized preamble, not a fresh answer, so it must not re-suppress
        // the working indicator across the gap before the tool starts.
        current.pendingToolAfterPreamble
      ) {
        return state
      }
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            isStreamingText: true,
          },
        },
      }
    }
    case 'assistant-message-boundary': {
      // A preamble message that ends with a tool call is interim, not the
      // final answer. Clear `isStreamingText` here so the working indicator
      // re-appears immediately at the boundary and stays up across the gap
      // before `tool-start` arrives — otherwise it lingers dismissed over
      // the visible preamble text, making it look like nothing is happening.
      // No-op for a plain boundary (final answer): keep its existing hand-off.
      if (!action.followedByToolCall) {
        return state
      }
      const current = state.runsById[action.runId]
      if (!current || current.terminal) {
        return state
      }
      // Set the suppression flag unconditionally so a stale marker cannot
      // reopen the gap regardless of event ordering.
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            isStreamingText: false,
            pendingToolAfterPreamble: true,
          },
        },
      }
    }
    case 'tool-start': {
      const current =
        state.runsById[action.runId] ??
        createEmptyRunRecord({
          runId: action.runId,
          conversationId: action.conversationId,
        })
      if (current.terminal) {
        return state
      }
      const toolCallKey = toToolCallKey(action)
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            hasToolActivity: true,
            // The model has stopped emitting text to run a tool; clear the
            // streaming-text flag so the post-tool reasoning gap shows the
            // working indicator again. Re-arming is safe: the post-tool
            // answer is a new assistant message (the agent loop emits the
            // `message_end` boundary before this tool start), so it streams
            // into a fresh overlay slot and its first visible provider delta
            // sets `isStreamingText` back to true.
            isStreamingText: false,
            // Deliberately DO NOT release `pendingToolAfterPreamble` here.
            // An out-of-order preamble marker could arrive after this
            // `tool-start`. Clearing the flag here would let that marker set
            // `isStreamingText: true`; it stays masked by `isToolActive`
            // while the tool runs, but sticks true after `tool-end`, blanking
            // the indicator across the post-tool reasoning gap (dead air,
            // most visible after `spawn_agent`). The suppression is released
            // in `tool-end` instead, once the tool phase is fully over.
            statusText: action.statusText ?? current.statusText,
            activeToolCalls: {
              ...(current.activeToolCalls ?? {}),
              [toolCallKey]: {
                toolName: action.toolName ?? 'tool',
                statusText: action.statusText ?? null,
              },
            },
          },
        },
      }
    }
    case 'tool-end': {
      const current = state.runsById[action.runId]
      if (!current || current.terminal) {
        return state
      }
      const nextActiveToolCalls = { ...(current.activeToolCalls ?? {}) }
      const toolCallKey = resolveToolEndKey(nextActiveToolCalls, action)
      if (toolCallKey) {
        delete nextActiveToolCalls[toolCallKey]
      }
      const nextActiveTool = Object.values(nextActiveToolCalls).at(-1)
      const toolPhaseOver = Object.keys(nextActiveToolCalls).length === 0
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            hasToolActivity: true,
            // Release stale-marker suppression only once the whole tool phase
            // is over (no tool still in flight), so an out-of-order preamble
            // marker cannot set `isStreamingText: true` and blank the indicator in the
            // post-tool reasoning gap. Keeping it set until the last tool ends
            // also covers parallel tool calls. The post-tool answer's first
            // visible delta then hands off normally.
            ...(toolPhaseOver ? { pendingToolAfterPreamble: false } : {}),
            statusText: nextActiveTool?.statusText ?? null,
            activeToolCalls: nextActiveToolCalls,
          },
        },
      }
    }
    case 'tool-activity-observed': {
      const current = state.runsById[action.runId]
      if (!current || current.terminal) {
        return state
      }
      const hasActiveTool =
        Object.keys(current.activeToolCalls ?? {}).length > 0
      return {
        ...state,
        runsById: {
          ...state.runsById,
          [action.runId]: {
            ...current,
            hasToolActivity: true,
            statusText: hasActiveTool ? current.statusText : null,
          },
        },
      }
    }
    case 'run-finished': {
      const current = state.runsById[action.runId]
      const nextRun: RunRecord = createEmptyRunRecord({
        runId: action.runId,
        conversationId: action.conversationId,
        requestId: current?.requestId,
        userMessageId: current?.userMessageId,
        terminal: true,
        outcome: action.outcome,
      })
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
      // A task lives under exactly one run: lifecycle events always carry
      // the task's CURRENT rootRunId, so when a send_input follow-up
      // rebinds a running task to the caller's run, any copy still parked
      // under another run is a stale snapshot. Evict it — a frozen
      // "running" copy left under the spawn run never receives a terminal
      // event (the completion streams under the new run) and would win the
      // footer merge forever, pinning the Activity row open after the
      // follow-up completes.
      let evictedCopy: TaskItem | undefined
      let baseTasksByRunId = state.tasksByRunId
      for (const [runId, tasks] of Object.entries(state.tasksByRunId)) {
        if (runId === action.runId || !(action.task.id in tasks)) {
          continue
        }
        if (baseTasksByRunId === state.tasksByRunId) {
          baseTasksByRunId = { ...state.tasksByRunId }
        }
        const remaining = { ...tasks }
        evictedCopy = evictedCopy ?? remaining[action.task.id]
        delete remaining[action.task.id]
        baseTasksByRunId[runId] = remaining
      }
      // The evicted copy still seeds continuity fields (description,
      // startedAtMs) so the row doesn't reset when the task moves runs.
      const existing = runTasks[action.task.id] ?? evictedCopy
      const nextDescription =
        isFallbackTaskDescription(action.task.description, action.task.id) &&
        existing?.description &&
        !isFallbackTaskDescription(existing.description, action.task.id)
          ? existing.description
          : action.task.description
      const nextTask: TaskItem = {
        ...action.task,
        description: nextDescription,
        anchorTurnId: action.task.anchorTurnId ?? existing?.anchorTurnId,
        groupKey: action.task.groupKey ?? existing?.groupKey,
        groupLabel: action.task.groupLabel ?? existing?.groupLabel,
        startedAtMs: existing?.startedAtMs ?? action.task.startedAtMs,
        statusText:
          action.task.status === 'running'
            ? (normalizeTaskDisplayStatusText(action.task.statusText) ??
              normalizeTaskDisplayStatusText(existing?.statusText) ??
              (isGenericTaskDescription(nextDescription)
                ? undefined
                : nextDescription))
            : undefined,
        toolActivity:
          action.task.status === 'running'
            ? (action.task.toolActivity ?? existing?.toolActivity)
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
              [action.runId]: createEmptyRunRecord({
                runId: action.runId,
                conversationId: action.conversationId,
                userMessageId: action.userMessageId,
                uiVisibility: 'hidden',
              }),
            },
        tasksByRunId: {
          ...baseTasksByRunId,
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
              [action.runId]: createEmptyRunRecord({
                runId: action.runId,
                conversationId: action.conversationId,
                userMessageId: action.userMessageId,
                uiVisibility: 'hidden',
              }),
            },
        tasksByRunId: {
          ...state.tasksByRunId,
          [action.runId]: {
            ...runTasks,
            [action.agentId]: {
              ...(existing ?? {
                id: action.agentId,
                description:
                  action.description ??
                  fallbackTaskDescription(action.agentId),
                agentType: AGENT_IDS.GENERAL,
                status: 'running',
                anchorTurnId: runRecord?.userMessageId,
                startedAtMs: nowMs,
                lastUpdatedAtMs: nowMs,
              }),
              // A reasoning event carrying the spawn description upgrades a
              // placeholder created before the description was known.
              ...(existing &&
              action.description &&
              isFallbackTaskDescription(existing.description, action.agentId)
                ? { description: action.description }
                : {}),
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
    case 'clear-conversation-tasks': {
      const nextTasksByRunId = Object.fromEntries(
        Object.entries(state.tasksByRunId).filter(([runId]) => {
          const runRecord = state.runsById[runId]
          return runRecord?.conversationId !== action.conversationId
        }),
      )
      const activeRunId =
        state.activeRunIdByConversation[action.conversationId] ?? null
      const nextActiveRunIdByConversation =
        activeRunId === null
          ? state.activeRunIdByConversation
          : {
              ...state.activeRunIdByConversation,
              [action.conversationId]: null,
            }
      return {
        ...state,
        tasksByRunId: nextTasksByRunId,
        activeRunIdByConversation: nextActiveRunIdByConversation,
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
          ...createEmptyRunRecord({
            runId,
            conversationId: action.conversationId,
          }),
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
            ...createEmptyRunRecord({
              runId,
              conversationId: action.conversationId,
              requestId: action.activeRun.requestId,
              userMessageId: action.activeRun.userMessageId,
              uiVisibility: action.activeRun.uiVisibility,
            }),
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
): { url: string; mimeType?: string; previewUrl?: string }[] | undefined {
  if (!attachments?.length) return undefined
  const mapped = attachments
    .filter(
      (a): a is AttachmentRef & { url: string } =>
        typeof a.url === 'string' && a.url.length > 0,
    )
    .map((a) => {
      const item: { url: string; mimeType?: string; previewUrl?: string } = {
        url: a.url,
      }
      if (a.mimeType) item.mimeType = a.mimeType
      if (a.previewUrl) item.previewUrl = a.previewUrl
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
  hydratedFromResumeSnapshot: true,
  description:
    snapshot.description ?? fallbackTaskDescription(snapshot.agentId),
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
  // Prefer the snapshot's real timestamps: fabricating `nowMs` here made a
  // re-hydrated finished task look freshly started/completed, which both
  // tripped the revive rule in mergeFooterTasks and collapsed the done-row
  // sort into id order (every row got the same synthetic stamp). `nowMs` is
  // only a fallback for snapshots that predate the timestamp fields.
  startedAtMs: snapshot.startedAtMs ?? nowMs,
  completedAtMs:
    snapshot.status === 'completed' ||
    snapshot.status === 'error' ||
    snapshot.status === 'canceled'
      ? (snapshot.completedAtMs ?? nowMs)
      : undefined,
  lastUpdatedAtMs: nowMs,
  outputPreview: snapshot.result ?? snapshot.error,
  reasoningText: snapshot.reasoningText,
  groupKey: snapshot.groupKey,
  groupLabel: snapshot.groupLabel,
})
