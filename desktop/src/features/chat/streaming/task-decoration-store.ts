/**
 * Module-level store for per-thread ephemeral stream decoration —
 * statusText ticks, tool activity, reasoning — keyed by the thread's
 * durable `agentId`, never by run. Authoritative task state (status,
 * description, timestamps, result) lives in the thread-activity rows;
 * a decoration only carries the high-frequency display extras the rows
 * don't persist, and is cleared on the thread's terminal stream event.
 *
 * Lives outside the React tree so BOTH kinds of consumer can read it:
 * the conversation-level task list (`useFullShellChat` merges the whole
 * snapshot via `buildActivityTasks`) and individual inline chat cards
 * (`BackgroundWorkCard` subscribes to just its own thread, so a
 * reasoning tick re-renders one card, not every activity surface).
 */
import {
  normalizeTaskDisplayStatusText,
  type TaskLiveDecoration,
} from '@/features/chat/lib/event-transforms'

export type TaskDecoration = TaskLiveDecoration & {
  agentId: string
  conversationId: string
  lastUpdatedAtMs: number
}

export const MAX_AGENT_REASONING_CHARS = 8_000

/** Terminal-clear normally keeps the map tiny; the cap only guards against
 *  threads whose terminal event streamed while the renderer wasn't looking
 *  (their stale decoration is already ignored by the merge). */
export const MAX_TASK_DECORATIONS = 64

const decorations = new Map<string, TaskDecoration>()
/** Immutable snapshot rebuilt on mutation — stable identity between writes
 *  so `useSyncExternalStore` consumers can memo off it. */
let snapshot: Record<string, TaskDecoration> = {}

const globalListeners = new Set<() => void>()
const agentListeners = new Map<string, Set<() => void>>()

const notify = (agentIds: Iterable<string>) => {
  snapshot = Object.fromEntries(decorations)
  for (const listener of globalListeners) listener()
  for (const agentId of agentIds) {
    const listeners = agentListeners.get(agentId)
    if (!listeners) continue
    for (const listener of listeners) listener()
  }
}

const setDecoration = (next: TaskDecoration) => {
  const isNew = !decorations.has(next.agentId)
  decorations.set(next.agentId, next)
  // Updates can't grow the map — only a genuinely new key pays the
  // eviction scan.
  if (isNew && decorations.size > MAX_TASK_DECORATIONS) {
    let oldestId: string | undefined
    let oldestAtMs = Infinity
    for (const [agentId, decoration] of decorations) {
      if (decoration.lastUpdatedAtMs < oldestAtMs) {
        oldestAtMs = decoration.lastUpdatedAtMs
        oldestId = agentId
      }
    }
    if (oldestId !== undefined && oldestId !== next.agentId) {
      decorations.delete(oldestId)
      notify([next.agentId, oldestId])
      return
    }
  }
  notify([next.agentId])
}

export const decorateTask = (input: {
  agentId: string
  conversationId: string
  runId?: string
  anchorTurnId?: string
  statusText?: string
  toolActivity?: TaskDecoration['toolActivity']
}): void => {
  const existing = decorations.get(input.agentId)
  setDecoration({
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId: input.runId ?? existing?.runId,
    anchorTurnId: input.anchorTurnId ?? existing?.anchorTurnId,
    statusText:
      normalizeTaskDisplayStatusText(input.statusText) ?? existing?.statusText,
    toolActivity: input.toolActivity ?? existing?.toolActivity,
    reasoningText: existing?.reasoningText,
    lastUpdatedAtMs: Date.now(),
  })
}

export const appendTaskReasoning = (input: {
  agentId: string
  conversationId: string
  runId?: string
  chunk: string
}): void => {
  if (!input.chunk) return
  const existing = decorations.get(input.agentId)
  const nextReasoningText = `${existing?.reasoningText ?? ''}${input.chunk}`
  setDecoration({
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId: input.runId ?? existing?.runId,
    anchorTurnId: existing?.anchorTurnId,
    statusText: existing?.statusText,
    toolActivity: existing?.toolActivity,
    reasoningText:
      nextReasoningText.length > MAX_AGENT_REASONING_CHARS
        ? nextReasoningText.slice(-MAX_AGENT_REASONING_CHARS)
        : nextReasoningText,
    lastUpdatedAtMs: Date.now(),
  })
}

export const clearTaskDecoration = (agentId: string): void => {
  if (!decorations.delete(agentId)) return
  notify([agentId])
}

export const clearConversationTaskDecorations = (
  conversationId: string,
): void => {
  const removed: string[] = []
  for (const [agentId, decoration] of decorations) {
    if (decoration.conversationId === conversationId) {
      decorations.delete(agentId)
      removed.push(agentId)
    }
  }
  if (removed.length > 0) notify(removed)
}

export const getTaskDecorationsSnapshot = (): Record<string, TaskDecoration> =>
  snapshot

export const getTaskDecoration = (
  agentId: string,
): TaskDecoration | undefined => snapshot[agentId]

export const subscribeTaskDecorations = (listener: () => void): (() => void) => {
  globalListeners.add(listener)
  return () => {
    globalListeners.delete(listener)
  }
}

export const subscribeTaskDecoration = (
  agentId: string,
  listener: () => void,
): (() => void) => {
  let listeners = agentListeners.get(agentId)
  if (!listeners) {
    listeners = new Set()
    agentListeners.set(agentId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      agentListeners.delete(agentId)
    }
  }
}

export const __privateTaskDecorationStore = {
  resetForTests() {
    decorations.clear()
    snapshot = {}
    globalListeners.clear()
    agentListeners.clear()
  },
}
