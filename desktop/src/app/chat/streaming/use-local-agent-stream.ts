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
import type { AgentResponseTarget } from './streaming-types'
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
  const [streamingResponseTarget, setStreamingResponseTarget] =
    useState<AgentResponseTarget | null>(null)

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

  const activeRunId = activeConversationId
    ? (storeState.activeRunIdByConversation[activeConversationId] ?? null)
    : null
  const activeRun = activeRunId
    ? (storeState.runsById[activeRunId] ?? null)
    : null
  const isStreaming = Boolean(activeRun && !activeRun.terminal)
  const runtimeStatusText = activeRun?.statusText ?? null

  const streamingBuffer = useStreamBuffer(isStreaming)
  const reasoningBuffer = useStreamBuffer(isStreaming)
  const streamingText = streamingBuffer.text
  const reasoningText = reasoningBuffer.text
  const appendStreamingDelta = streamingBuffer.append
  const resetStreamingText = streamingBuffer.reset
  const resetReasoningText = reasoningBuffer.reset

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
      appendStreamingDelta,
      resetStreamingText,
      resetReasoningText,
      setPendingUserMessageId,
      setStreamingResponseTarget,
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
      setStreamingResponseTarget,
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
    startStream,
    queueStream,
    cancelCurrentStream,
    resetStreamingState,
  }
}
