import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { isActivityFeedTask } from '@/features/chat/lib/event-transforms'
import { showToast } from '@/ui/toast'
import { useResumeAgentRun } from '../hooks/use-resume-agent-run'
import {
  attachmentsForStartChat,
  initialStoreState,
  streamStoreReducer,
} from './store'
import { useReasoningBatcher } from './use-reasoning-batcher'
import { useStreamTextAnimation } from './use-stream-text-animation'
import { useTaskRemovalTimers } from './use-task-removal-timers'
import { useAgentEventHandler } from './use-agent-event-handler'
import { useApplyResumeSnapshot } from './use-resume-snapshot'
import type {
  AgentResponseTarget,
  StreamingAssistantOverlay,
} from './streaming-types'
import {
  assistantScrollFollowKey,
  linkStreamingAssistantCanonicalMessage,
  reconcileStreamingAssistantCanonicalMessage,
  streamingAssistantOverlayId,
} from './streaming-types'
import {
  beginAssistantScrollFollow,
  clearAssistantScrollFollow,
  notifyAssistantScrollFollowLayoutChange,
} from '@/shell/chat-scroll-follow'
import type { AttachmentRef } from './chat-types'
import type { ChatContext } from '@/shared/types/electron'
import { resolveAgentNotReadyToast } from './agent-stream-errors'
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from './stella-provider-error-toast'

// Re-export for callers/tests that still import the helper from here.
export { reconcileTerminalTaskKeysFromResumeTasks } from './store'

type UseLocalAgentStreamOptions = {
  activeConversationId: string | null
  storageMode: 'cloud' | 'local'
  onRunStarted?: (event: {
    runId: string
    conversationId: string
    userMessageId?: string
  }) => void
  onRunFinished?: (event: {
    runId: string
    conversationId: string
    userMessageId?: string
    outcome: 'completed' | 'error' | 'canceled'
  }) => void
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
  /** Renderer send time, preserved across queued drains and IPC latency. */
  userMessageTimestamp?: number
  onStartFailed?: () => void
}

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
  onRunStarted,
  onRunFinished,
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
   * Entries keep owning the visible text while present, even after
   * SQLite has persisted the matching `(userMessageId, indexInTurn)`
   * slot.
   */
  const [streamingAssistants, setStreamingAssistants] = useState<
    StreamingAssistantOverlay[]
  >([])

  const activeConversationIdRef = useRef<string | null>(activeConversationId)
  const activeRunIdByConversationRef = useRef<Record<string, string | null>>(
    storeState.activeRunIdByConversation,
  )
  const lastSeqByConversationRef = useRef(new Map<string, number>())
  const resumeSeqByConversationRef = useRef(new Map<string, number>())
  const seenSourceEventKeysRef = useRef(new Set<string>())
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
  const activeToolEntry = Object.entries(activeRun?.activeToolCalls ?? {}).at(-1)
  const activeToolCallId = activeToolEntry?.[0] ?? null
  const activeToolName = activeToolEntry?.[1]?.toolName ?? null
  const hasToolActivity = Boolean(activeRun?.hasToolActivity)
  const isToolActive = Boolean(activeToolName)
  const isStreamingResponseText = Boolean(activeRun?.isStreamingText)

  const reasoningText = ''

  /** Apply an idempotent full-text animation frame to its overlay slot. */
  const revealStreamText = useCallback(
    (slotId: string, visibleText: string) => {
      setStreamingAssistants((current) => {
        const index = current.findIndex((slot) => slot._id === slotId)
        const slot = index >= 0 ? current[index] : undefined
        if (!slot || slot.text === visibleText) return current
        const next = current.slice()
        next[index] = { ...slot, text: visibleText }
        return next
      })
      notifyAssistantScrollFollowLayoutChange()
    },
    [],
  )

  const {
    enqueue: animateStreamText,
    finish: finishStreamText,
    discard: discardStreamText,
  } = useStreamTextAnimation({ onReveal: revealStreamText })

  /** Lock one exact slot after all text received for it has been revealed. */
  const lockStreamSlot = useCallback((slotId: string) => {
    setStreamingAssistants((current) => {
      const index = current.findIndex((slot) => slot._id === slotId)
      const slot = index >= 0 ? current[index] : undefined
      if (!slot || slot.locked) return current
      const next = current.slice()
      next[index] = { ...slot, locked: true }
      return next
    })
  }, [])

  const lockAndDiscardStreamSlot = useCallback(
    (slotId: string) => {
      lockStreamSlot(slotId)
      discardStreamText((entry) => entry.slotId === slotId)
    },
    [discardStreamText, lockStreamSlot],
  )

  /**
   * RUN_STARTED for a visible run: finish any prior run's pending playout and
   * reset the per-turn slot index so the next chunk lands on a fresh slot.
   * Prior overlays remain in the timeline; failed/canceled runs may not have a
   * persisted twin, so dropping them here would lose received response text.
   */
  const beginStreamingRun = useCallback(
    (args: { runId: string; userMessageId: string | null }) => {
      clearAssistantScrollFollow()
      finishStreamText(
        (entry) => entry.runId !== args.runId,
        lockAndDiscardStreamSlot,
      )
      if (args.userMessageId) {
        nextSlotIndexByUserMessageIdRef.current.set(args.userMessageId, 1)
      }
    },
    [finishStreamText, lockAndDiscardStreamSlot],
  )

  /**
   * STREAM chunk: ensure the current overlay slot for
   * `(userMessageId, currentIndex)` exists, then hand the chunk to the
   * frame-driven text animator. Provider chunk boundaries stay out of the
   * visual layer; hidden runs and runs without a `userMessageId` never produce
   * overlays.
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
        return
      }
      const userMessageId = args.userMessageId
      const expectedIndex =
        nextSlotIndexByUserMessageIdRef.current.get(userMessageId) ?? 1
      nextSlotIndexByUserMessageIdRef.current.set(userMessageId, expectedIndex)
      const slotId = streamingAssistantOverlayId(userMessageId, expectedIndex)
      setStreamingAssistants((current) => {
        const existingIndex = current.findIndex((slot) => slot._id === slotId)
        if (existingIndex >= 0) {
          const existing = current[existingIndex]
          if (!existing) return current
          if (!existing.locked) return current
          const next = current.slice()
          next[existingIndex] = {
            ...existing,
            locked: false,
          }
          return next
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
        beginAssistantScrollFollow(
          assistantScrollFollowKey(userMessageId, expectedIndex),
        )
        return [...current, newSlot]
      })
      notifyAssistantScrollFollowLayoutChange()
      animateStreamText(slotId, args.runId, args.chunk)
    },
    [animateStreamText],
  )

  /**
   * `ASSISTANT_MESSAGE` boundary: lock the current slot, increment the
   * slot index, and let the next chunk create the next slot.
   */
  const finalizeMessageBoundary = useCallback(
    (args: {
      runId: string
      userMessageId: string | null
      canonicalMessageId?: string
      canonicalText?: string
    }) => {
      const currentIndex = args.userMessageId
        ? (nextSlotIndexByUserMessageIdRef.current.get(args.userMessageId) ?? 1)
        : null
      finishStreamText(
        (entry) => entry.runId === args.runId,
        lockStreamSlot,
      )
      if (args.userMessageId && currentIndex !== null) {
        if (args.canonicalText !== undefined) {
          const slotId = streamingAssistantOverlayId(
            args.userMessageId,
            currentIndex,
          )
          // Prevent a late animation frame from restoring a discarded delta.
          discardStreamText((entry) => entry.slotId === slotId)
          setStreamingAssistants((current) =>
            reconcileStreamingAssistantCanonicalMessage(current, {
              userMessageId: args.userMessageId!,
              indexInTurn: currentIndex,
              ...(args.canonicalMessageId
                ? { canonicalMessageId: args.canonicalMessageId }
                : {}),
              canonicalText: args.canonicalText!,
            }),
          )
        } else if (args.canonicalMessageId) {
          setStreamingAssistants((current) =>
            linkStreamingAssistantCanonicalMessage(current, {
              userMessageId: args.userMessageId!,
              indexInTurn: currentIndex,
              canonicalMessageId: args.canonicalMessageId!,
            }),
          )
        }
        // Keep the active follow key until the next slot's first chunk
        // calls `beginAssistantScrollFollow` — clearing here dropped
        // auto-follow for late layout (image cards, undo) after the
        // final assistant message in a run.
        nextSlotIndexByUserMessageIdRef.current.set(
          args.userMessageId,
          currentIndex + 1,
        )
      }
    },
    [discardStreamText, finishStreamText, lockStreamSlot],
  )

  /**
   * `RUN_FINISHED` (any outcome): lock the current slot and stop
   * expecting more chunks. The remaining overlay entries stay in the
   * array so the active UI does not swap from streamed text to SQLite
   * just because persistence completed.
   */
  const finalizeRunOnFinish = useCallback(
    (args: { runId: string }) => {
      finishStreamText(
        (entry) => entry.runId === args.runId,
        lockStreamSlot,
      )
    },
    [finishStreamText, lockStreamSlot],
  )

  /**
   * Marks persisted text restored for a resumed run as visible response text.
   * Live runs are marked directly from their first non-whitespace stream
   * event, without waiting for a client-side animation or paint callback.
   */
  const markAssistantResponseTextStarted = useCallback(() => {
    const conversationId = activeConversationIdRef.current
    const runId = conversationId
      ? (activeRunIdByConversationRef.current[conversationId] ?? null)
      : null
    if (runId) {
      dispatch({ type: 'mark-streaming-text', runId })
    }
  }, [])

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  useEffect(() => {
    activeRunIdByConversationRef.current = storeState.activeRunIdByConversation
  }, [storeState.activeRunIdByConversation])

  const timers = useTaskRemovalTimers(dispatch)
  const reasoning = useReasoningBatcher(dispatch)
  const lifecycleCallbacks = useMemo(
    () => ({
      onRunStarted,
      onRunFinished,
    }),
    [onRunFinished, onRunStarted],
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
    clearAssistantScrollFollow()
    discardStreamText()
    setPendingUserMessageId(null)
    setStreamingAssistants([])
    nextSlotIndexByUserMessageIdRef.current.clear()
    // This callback is handed to `useResumeAgentRun`, whose effect depends on
    // its identity. Reading the live ids from refs keeps the callback stable
    // across RUN_FINISHED; otherwise terminal state changed `activeRunId`,
    // restarted the resume effect, and its no-active-run cleanup discarded a
    // still-draining text buffer so SQLite's full message appeared at once.
    const conversationId = activeConversationIdRef.current
    const runId = conversationId
      ? (activeRunIdByConversationRef.current[conversationId] ?? null)
      : null
    if (conversationId) {
      dispatch({
        type: 'clear-conversation-tasks',
        conversationId,
      })
    } else if (runId) {
      dispatch({
        type: 'clear-run-tasks',
        runId,
      })
    }
  }, [discardStreamText])

  const handleAgentEvent = useAgentEventHandler({
    dispatch,
    refs: {
      activeConversationIdRef,
      activeRunIdByConversationRef,
      lastSeqByConversationRef,
      resumeSeqByConversationRef,
      seenSourceEventKeysRef,
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
    },
    timers,
    reasoning,
    lifecycle: lifecycleCallbacks,
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
      resumeSeqByConversationRef,
    },
    actions: {
      ensureAgentStreamSubscription,
      applyResumeSnapshot,
      handleAgentEvent,
      clearReplayedStreamingState: resetStreamingState,
    },
  })

  useEffect(() => {
    clearAssistantScrollFollow()
    discardStreamText()
    setStreamingAssistants([])
    nextSlotIndexByUserMessageIdRef.current.clear()
    seenSourceEventKeysRef.current.clear()
    const timeoutId = window.setTimeout(() => {
      setPendingUserMessageId(null)
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [activeConversationId, discardStreamText])

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId || !window.electronAPI) {
        args.onStartFailed?.()
        return
      }

      ensureAgentStreamSubscription()

      if (args.userMessageEventId && args.mode !== 'follow_up') {
        setPendingUserMessageId(args.userMessageEventId)
      }

      const attemptId = ++startAttemptRef.current
      const startChatAttachments = attachmentsForStartChat(args.attachments)
      // The composer's attached images/files already travel as
      // `attachments` — shipping them again inside chatContext doubles a
      // potentially huge base64 payload across the IPC bridge for fields
      // the runtime never reads (it only consumes windowScreenshot,
      // window/AX, selection, and pasted text from chatContext).
      const startChatContext = args.chatContext
        ? {
            ...args.chatContext,
            regionScreenshots: undefined,
            files: undefined,
          }
        : args.chatContext

      void (async () => {
        if (attemptId !== startAttemptRef.current) return

        const { requestId } = await window.electronAPI!.agent.startChat({
          conversationId: activeConversationId,
          userPrompt: args.userPrompt,
          ...(typeof args.selectedText !== 'undefined'
            ? { selectedText: args.selectedText }
            : {}),
          ...(typeof startChatContext !== 'undefined'
            ? { chatContext: startChatContext }
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
          ...(Number.isFinite(args.userMessageTimestamp)
            ? { userMessageTimestamp: args.userMessageTimestamp }
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
          const reason = (error as Error).message || null
          // A queued / follow-up message whose start fails because the user hit
          // an anonymous cap or usage/auth limit must show the same actionable
          // "Sign in to keep using Stella" toast as the live send path — not the
          // generic "Stella is still starting up". `resolveAgentNotReadyToast`
          // only understands local startup hiccups, so route real backend
          // limit/auth reasons through the provider-error resolver (which
          // carries the Sign in / Upgrade / BYOK CTAs).
          if (isStellaLimitOrAuthReason(reason)) {
            showToast(resolveStellaProviderErrorToast(reason))
          } else {
            const toast = resolveAgentNotReadyToast(reason)
            showToast({
              title: toast.title,
              description:
                toast.description || reason || 'Please try again.',
              variant: 'error',
            })
          }
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
          // Orchestrator-internal helper agents (schedule specialists, …)
          // are execution detail — never user-facing activity rows.
          return Object.values(taskMap)
            .filter(isActivityFeedTask)
            .map((task) => ({
              ...task,
              // Stamp the owning run id (live task-upserts don't carry it).
              // Picking a task in the workspace strip turns it into a
              // ChatContext.activity via `taskToActivityContext`, whose
              // `runId` is emitted as `run-id="…"` in the agent prompt
              // context (runtime/kernel/chat-prompt-context), so a still-live
              // task needs it before it has been persisted.
              runId: task.runId ?? runId,
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
    markAssistantResponseTextStarted,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    isStreamingResponseText,
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
