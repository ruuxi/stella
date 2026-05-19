import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { showToast } from '@/ui/toast'
import { useStreamBuffer } from '@/shared/hooks/use-stream-buffer'
import { useResumeAgentRun } from '../hooks/use-resume-agent-run'
import {
  attachmentsForStartChat,
  initialStoreState,
  streamStoreReducer,
} from './store'
import { useReasoningBatcher } from './use-reasoning-batcher'
import { useTaskRemovalTimers } from './use-task-removal-timers'
import { useAgentEventHandler } from './use-agent-event-handler'
import { useApplyResumeSnapshot } from './use-resume-snapshot'
import type {
  AgentResponseTarget,
  StreamingAssistantOverlay,
} from './streaming-types'
import { streamingAssistantOverlayId } from './streaming-types'
import type { AttachmentRef } from './chat-types'
import type { ChatContext } from '@/shared/types/electron'
import { resolveAgentNotReadyToast } from './agent-stream-errors'

// Re-export for callers/tests that still import the helper from here.
export { reconcileTerminalTaskKeysFromResumeTasks } from './store'

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

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
}: UseLocalAgentStreamOptions) {
  const [storeState, dispatch] = useReducer(
    streamStoreReducer,
    initialStoreState,
  )
  const [pendingUserMessageId, setPendingUserMessageId] = useState<
    string | null
  >(null)
  /**
   * In-memory assistant messages currently being streamed for the
   * active conversation. The renderer merges these into
   * `displayMessages` so the live stream is just a regular assistant
   * row (whose text grows) rather than a separate "tail" overlay.
   * Entries drop the moment a persisted row at the same
   * `(userMessageId, indexInTurn)` slot lands via `chat:localUpdated`.
   */
  const [streamingAssistants, setStreamingAssistants] = useState<
    StreamingAssistantOverlay[]
  >([])

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
  /**
   * Active slot index per `userMessageId` for the in-flight run. The
   * first chunk of a turn pushes overlay slot 1; each
   * `ASSISTANT_MESSAGE` boundary increments the index; the next chunk
   * pushes overlay slot N at the new index.
   */
  const nextSlotIndexByUserMessageIdRef = useRef(new Map<string, number>())
  const startAttemptRef = useRef(0)
  const agentStreamCleanupRef = useRef<(() => void) | null>(null)

  const activeRunId = activeConversationId
    ? (storeState.activeRunIdByConversation[activeConversationId] ?? null)
    : null
  const activeRun = activeRunId
    ? (storeState.runsById[activeRunId] ?? null)
    : null
  const isStreaming = Boolean(activeRun && !activeRun.terminal)
  const runtimeStatusText = activeRun?.statusText ?? null

  // Smoothing buffer for the assistant text. The buffer's `text` is
  // mirrored into the LAST entry of `streamingAssistants` via an
  // effect, so chunky upstream bursts get visually spread word-by-word
  // even though the slot itself is a regular `MessageRecord`.
  //
  // The buffer object itself is a fresh literal every render — its
  // method props (`append`/`reset`/`flushAll`) are stable useCallback
  // references though. Destructure once so the rest of this hook can
  // pin its `useCallback`/`useEffect` deps on the stable methods
  // instead of the object reference, otherwise everything downstream
  // (the slot-management callbacks, the conversation-switch reset
  // effect, the persisted-vs-pending effect that consumes
  // `resetStreamingState`) re-creates every smoothing tick and the
  // resulting setState cascade trips React's max-update-depth guard.
  const streamingBuffer = useStreamBuffer(isStreaming)
  const reasoningBuffer = useStreamBuffer(isStreaming)
  const {
    append: appendSmoothingChunk,
    reset: resetSmoothingBuffer,
    flushAll: flushSmoothingBuffer,
  } = streamingBuffer
  const reasoningText = reasoningBuffer.text
  const resetReasoningText = reasoningBuffer.reset

  // Mirror smoothing.text → currently-active streaming-assistant slot.
  // The slot lifecycle (push on chunk / flush+increment on boundary)
  // ensures the buffer text always belongs to the latest slot in
  // `streamingAssistants`. Equality short-circuit avoids a re-render
  // when nothing changed. `locked` slots are immune (their text was
  // committed by `finalizeMessageBoundary` / `finalizeRunOnFinish`
  // and must not be wiped by a subsequent `streamBuffer.reset()`).
  const smoothingText = streamingBuffer.text
  useEffect(() => {
    setStreamingAssistants((current) => {
      if (current.length === 0) return current
      const last = current[current.length - 1]
      if (last.locked) return current
      if (last.text === smoothingText) return current
      const next = current.slice()
      next[next.length - 1] = { ...last, text: smoothingText }
      return next
    })
  }, [smoothingText])

  /**
   * RUN_STARTED for a visible run: clear any leftover overlays scoped
   * to other runs, reset the per-turn slot index, and drain both
   * smoothing buffers so the next chunk lands on a fresh slot.
   */
  const beginStreamingRun = useCallback(
    (args: { runId: string; userMessageId: string | null }) => {
      setStreamingAssistants((current) =>
        current.filter((slot) => slot.runId === args.runId),
      )
      if (args.userMessageId) {
        nextSlotIndexByUserMessageIdRef.current.set(args.userMessageId, 1)
      }
      resetSmoothingBuffer()
      resetReasoningText()
    },
    [resetReasoningText, resetSmoothingBuffer],
  )

  /**
   * STREAM chunk: ensure the current overlay slot for
   * `(userMessageId, currentIndex)` exists and append the chunk into
   * the smoothing buffer. The mirror effect propagates smoothed text
   * into the slot. Hidden runs and runs without a `userMessageId`
   * never produce overlays.
   */
  const acceptStreamChunk = useCallback(
    (args: {
      runId: string
      userMessageId: string | null
      responseTarget?: AgentResponseTarget | null
      chunk: string
    }) => {
      if (!args.chunk) return
      if (!args.userMessageId) {
        // Nothing to anchor the overlay against; skip the slot and
        // let the smoothing buffer still consume the chunk so future
        // reads stay consistent.
        appendSmoothingChunk(args.chunk)
        return
      }
      const userMessageId = args.userMessageId
      const expectedIndex =
        nextSlotIndexByUserMessageIdRef.current.get(userMessageId) ?? 1
      nextSlotIndexByUserMessageIdRef.current.set(userMessageId, expectedIndex)
      const slotId = streamingAssistantOverlayId(userMessageId, expectedIndex)
      setStreamingAssistants((current) => {
        if (current.some((slot) => slot._id === slotId)) {
          return current
        }
        const newSlot: StreamingAssistantOverlay = {
          _id: slotId,
          userMessageId,
          indexInTurn: expectedIndex,
          text: '',
          ...(args.responseTarget ? { responseTarget: args.responseTarget } : {}),
          timestamp: Date.now(),
          runId: args.runId,
        }
        return [...current, newSlot]
      })
      appendSmoothingChunk(args.chunk)
    },
    [appendSmoothingChunk],
  )

  /**
   * `ASSISTANT_MESSAGE` boundary: flush smoothing so the current slot
   * carries the full received text for the just-finished message,
   * lock it, increment the slot index, and reset smoothing for the
   * next message. The newly-pushed (next) slot is empty until the
   * first post-boundary chunk arrives.
   */
  const finalizeMessageBoundary = useCallback(
    (args: { runId: string; userMessageId: string | null }) => {
      // Trim to match the worker's persisted form. The smoothing
      // buffer holds raw stream chunks (may carry a trailing newline
      // mid-burst); the worker `.trim()`s the same text before
      // persisting. Matching here means the overlay → persisted swap
      // at the same `assistantRowKey` slot is a byte-for-byte text
      // identity update inside Streamdown — no markdown re-flow, no
      // perceptible "settle" jump when the row content swaps.
      const fullText = flushSmoothingBuffer().trim()
      if (args.userMessageId) {
        const current =
          nextSlotIndexByUserMessageIdRef.current.get(args.userMessageId) ?? 1
        nextSlotIndexByUserMessageIdRef.current.set(
          args.userMessageId,
          current + 1,
        )
      }
      setStreamingAssistants((current) => {
        if (current.length === 0) return current
        const last = current[current.length - 1]
        if (last.runId !== args.runId) return current
        const lockedLast: StreamingAssistantOverlay = {
          ...last,
          text: fullText,
          locked: true,
        }
        return [...current.slice(0, -1), lockedLast]
      })
      // Reset smoothing so the next chunk drips into the next slot from
      // a clean state. The mirror effect won't touch `lockedLast`
      // (locked=true short-circuit), so the wiped smoothing text
      // won't bleed back into the previous slot.
      resetSmoothingBuffer()
    },
    [flushSmoothingBuffer, resetSmoothingBuffer],
  )

  /**
   * `RUN_FINISHED` (any outcome): drain smoothing into the current
   * slot, lock it, and stop expecting more chunks. The remaining
   * overlay entries stay in the array until their persisted
   * counterparts land via `chat:localUpdated` (see
   * `useConversationDisplayMessages`'s filter).
   */
  const finalizeRunOnFinish = useCallback(
    (args: { runId: string }) => {
      // Same trim invariant as `finalizeMessageBoundary` — see comment
      // there. Matters most at run-end because that's the swap the
      // user actually sees settle.
      const fullText = flushSmoothingBuffer().trim()
      setStreamingAssistants((current) => {
        if (current.length === 0) return current
        const last = current[current.length - 1]
        if (last.runId !== args.runId || last.locked) return current
        const lockedLast: StreamingAssistantOverlay = {
          ...last,
          text: fullText,
          locked: true,
        }
        return [...current.slice(0, -1), lockedLast]
      })
      resetSmoothingBuffer()
    },
    [flushSmoothingBuffer, resetSmoothingBuffer],
  )

  /**
   * Drop any overlays for the given run id. Used by the
   * conversation-switch effect below and by `resetStreamingState`.
   */
  const dropOverlaysForRun = useCallback((runId: string | null) => {
    if (runId === null) {
      setStreamingAssistants([])
      return
    }
    setStreamingAssistants((current) =>
      current.filter((slot) => slot.runId !== runId),
    )
  }, [])

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    activeRunIdByConversationRef.current = storeState.activeRunIdByConversation
  }, [storeState.activeRunIdByConversation])

  const timers = useTaskRemovalTimers(dispatch)
  const reasoning = useReasoningBatcher(dispatch)

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
    resetSmoothingBuffer()
    resetReasoningText()
    setPendingUserMessageId(null)
    setStreamingAssistants([])
    nextSlotIndexByUserMessageIdRef.current.clear()
    if (activeRunId) {
      dispatch({
        type: 'clear-run-tasks',
        runId: activeRunId,
      })
    }
  }, [activeRunId, resetReasoningText, resetSmoothingBuffer])

  const handleAgentEvent = useAgentEventHandler({
    dispatch,
    refs: {
      activeConversationIdRef,
      activeRunIdByConversationRef,
      lastSeqByConversationRef,
      terminalRunIdsRef,
      terminalTaskKeysRef,
      pendingRequestIdsRef,
    },
    streaming: {
      setPendingUserMessageId,
      beginStreamingRun,
      acceptStreamChunk,
      finalizeMessageBoundary,
      finalizeRunOnFinish,
      dropOverlaysForRun,
      resetReasoningText,
    },
    timers,
    reasoning,
  })

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

  const applyResumeSnapshot = useApplyResumeSnapshot({
    dispatch,
    refs: {
      activeConversationIdRef,
      terminalTaskKeysRef,
    },
    streaming: {
      setPendingUserMessageId,
    },
    timers,
  })

  useResumeAgentRun({
    activeConversationId,
    refs: {
      lastSeqByConversationRef,
    },
    actions: {
      ensureAgentStreamSubscription,
      applyResumeSnapshot,
      handleAgentEvent,
      clearReplayedStreamingState: resetStreamingState,
    },
  })

  useEffect(() => {
    resetSmoothingBuffer()
    resetReasoningText()
    setStreamingAssistants([])
    nextSlotIndexByUserMessageIdRef.current.clear()
    const timeoutId = window.setTimeout(() => {
      setPendingUserMessageId(null)
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [activeConversationId, resetReasoningText, resetSmoothingBuffer])

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId || !window.electronAPI) {
        args.onStartFailed?.()
        return
      }

      ensureAgentStreamSubscription()

      if (args.userMessageEventId) {
        setPendingUserMessageId(args.userMessageEventId)
      }

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
          if (args.userMessageEventId) {
            setPendingUserMessageId((current) =>
              current === args.userMessageEventId ? null : current,
            )
          }
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
    reasoningText,
    streamingAssistants,
    isStreaming,
    pendingUserMessageId,
    setPendingUserMessageId,
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  }
}
