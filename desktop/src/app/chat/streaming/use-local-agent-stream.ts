import { useCallback, useRef, useState } from 'react'
import { showToast } from '@/ui/toast'
import { getSearchHtmlPromptConfig } from '@/prompts'
import { useRafStringAccumulator } from '@/shared/hooks/use-raf-state'
import { useResumeAgentRun } from '../hooks/use-resume-agent-run'
import type { AgentStreamEvent, SelfModAppliedData } from './streaming-types'
import type { AttachmentRef } from './chat-types'
import {
  getAgentHealthReason,
  isOrchestratorBusyError,
  resolveAgentNotReadyToast,
  trySyncHostToken,
} from './agent-stream-errors'

type LocalAgentEvent = {
  type:
    | 'tool_request'
    | 'tool_result'
    | 'assistant_message'
    | 'task-started'
    | 'task-completed'
    | 'task-failed'
    | 'task-progress'
  agentType?: string
  userMessageId?: string
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  resultPreview?: string
  html?: string
  finalText?: string
  taskId?: string
  description?: string
  parentTaskId?: string
  result?: string
  error?: string
  statusText?: string
}

type UseLocalAgentStreamOptions = {
  activeConversationId: string | null
  storageMode: 'cloud' | 'local'
  appendAgentEvent: (event: LocalAgentEvent) => Promise<void> | void
}

type StartStreamArgs = {
  userMessageId: string
  userPrompt: string
  attachments?: AttachmentRef[]
}

const isTokenSyncIssue = (reason: string | null) =>
  Boolean(reason && reason.toLowerCase().match(/token|auth/))

export function useLocalAgentStream({
  activeConversationId,
  storageMode,
  appendAgentEvent,
}: UseLocalAgentStreamOptions) {
  const [streamingText, appendStreamingDelta, resetStreamingText, streamingTextRef] =
    useRafStringAccumulator()
  const [reasoningText, , resetReasoningText] = useRafStringAccumulator()
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingUserMessageId, setPendingUserMessageId] = useState<string | null>(
    null,
  )
  const [selfModMap, setSelfModMap] = useState<Record<string, SelfModAppliedData>>(
    {},
  )

  const streamRunIdRef = useRef(0)
  const localRunIdRef = useRef<string | null>(null)
  const localSeqByRunIdRef = useRef(new Map<string, number>())
  const userMessageIdByRunIdRef = useRef(new Map<string, string>())
  const agentStreamCleanupRef = useRef<(() => void) | null>(null)

  const resetStreamingState = useCallback(
    (runId?: number) => {
      if (typeof runId === 'number' && runId !== streamRunIdRef.current) {
        return
      }

      const scheduledForRunId = streamRunIdRef.current
      resetStreamingText()
      resetReasoningText()
      setIsStreaming(false)

      requestAnimationFrame(() => {
        if (scheduledForRunId !== streamRunIdRef.current) {
          return
        }

        setPendingUserMessageId(null)
      })
    },
    [resetReasoningText, resetStreamingText],
  )

  const cancelCurrentStream = useCallback(() => {
    if (localRunIdRef.current && window.electronAPI?.agent.cancelChat) {
      window.electronAPI.agent.cancelChat(localRunIdRef.current)
      userMessageIdByRunIdRef.current.delete(localRunIdRef.current)
      localRunIdRef.current = null
      localSeqByRunIdRef.current.clear()
    }

    if (agentStreamCleanupRef.current) {
      agentStreamCleanupRef.current()
      agentStreamCleanupRef.current = null
    }
  }, [])

  const handleAgentEvent = useCallback(
    (
      event: AgentStreamEvent,
      runIdCounter: number,
      options?: { userMessageId?: string },
    ) => {
      if (runIdCounter !== streamRunIdRef.current) return
      const currentSeq = localSeqByRunIdRef.current.get(event.runId) ?? 0
      if (event.seq <= currentSeq) return

      localSeqByRunIdRef.current.set(event.runId, event.seq)
      const isPrimaryRun = !localRunIdRef.current || event.runId === localRunIdRef.current
      const isOrchestratorEvent = (event.agentType ?? 'orchestrator') === 'orchestrator'

      switch (event.type) {
        case 'stream':
          if (isPrimaryRun && isOrchestratorEvent && event.chunk) {
            appendStreamingDelta(event.chunk)
          }
          break
        case 'tool-start':
          console.log(
            `[stella:trace] tool-start | ${event.toolName} | callId=${event.toolCallId}`,
          )
          appendAgentEvent({
            type: 'tool_request',
            agentType: event.agentType,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          })
          break
        case 'tool-end':
          console.log(
            `[stella:trace] tool-end   | ${event.toolName} | callId=${event.toolCallId} | preview=${event.resultPreview?.slice(0, 120)}`,
          )
          appendAgentEvent({
            type: 'tool_result',
            agentType: event.agentType,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            resultPreview: event.resultPreview,
            html: event.html,
          })
          break
        case 'task-started':
        case 'task-completed':
        case 'task-failed':
        case 'task-progress':
          console.log(
            `[stella:trace] ${event.type} | taskId=${event.taskId} | agent=${event.agentType} | status=${event.statusText ?? event.result ?? event.error ?? event.description ?? ''}`.trim(),
          )
          appendAgentEvent({
            type: event.type,
            agentType: event.agentType,
            taskId: event.taskId,
            description: event.description,
            parentTaskId: event.parentTaskId,
            result: event.result,
            error: event.error,
            statusText: event.statusText,
          })
          break
        case 'error':
          console.error(`[stella:trace] error | fatal=${event.fatal} | ${event.error}`)
          if (event.fatal && isPrimaryRun && isOrchestratorEvent) {
            showToast({
              title: 'Something went wrong',
              description: event.error || undefined,
              variant: 'error',
            })
            resetStreamingState(runIdCounter)
          }
          break
        case 'end':
          if (!isPrimaryRun || !isOrchestratorEvent) {
            break
          }
          {
            const linkedUserMessageId = userMessageIdByRunIdRef.current.get(event.runId)
          console.log(
            `[stella:trace] end | finalText=${(event.finalText ?? streamingTextRef.current).slice(0, 200)}`,
          )
          void Promise.resolve(
            appendAgentEvent({
              type: 'assistant_message',
              userMessageId: linkedUserMessageId,
              finalText: event.finalText ?? streamingTextRef.current,
            }),
          )
            .then(() => {
              if (!linkedUserMessageId) {
                resetStreamingState(runIdCounter)
              }
            })
            .catch(() => {
              resetStreamingState(runIdCounter)
            })

          userMessageIdByRunIdRef.current.delete(event.runId)

          if (event.selfModApplied && linkedUserMessageId) {
            const userMessageId = linkedUserMessageId
            const selfModApplied = event.selfModApplied
            setSelfModMap((previous) => ({
              ...previous,
              [userMessageId]: selfModApplied,
            }))
          }

          localRunIdRef.current = null
          localSeqByRunIdRef.current.delete(event.runId)
          }
          break
      }
    },
    [
      appendAgentEvent,
      appendStreamingDelta,
      resetStreamingState,
      streamingTextRef,
    ],
  )

  const startLocalStream = useCallback(
    (args: StartStreamArgs, runIdCounter: number) => {
      if (!activeConversationId || !window.electronAPI) {
        return
      }

      const cleanup = window.electronAPI.agent.onStream((event) => {
        handleAgentEvent(event, runIdCounter, {
          userMessageId: args.userMessageId,
        })
      })

      agentStreamCleanupRef.current = cleanup

      window.electronAPI.agent
        .startChat({
          conversationId: activeConversationId,
          userMessageId: args.userMessageId,
          userPrompt: args.userPrompt,
          storageMode,
          searchHtmlPrompts: getSearchHtmlPromptConfig(),
        })
        .then(({ runId: agentRunId }) => {
          if (runIdCounter !== streamRunIdRef.current) return
          localRunIdRef.current = agentRunId
          userMessageIdByRunIdRef.current.set(agentRunId, args.userMessageId)
          localSeqByRunIdRef.current.clear()
        })
        .catch((error) => {
          if (runIdCounter !== streamRunIdRef.current) return

          console.error('Failed to start local agent chat:', (error as Error).message)

          if (isOrchestratorBusyError(error)) {
            showToast({
              title: 'Stella is finishing your previous request',
              description: 'Try sending your next message in a moment.',
              variant: 'loading',
            })
            resetStreamingState(runIdCounter)
            return
          }

          showToast({
            title: "Stella couldn't start this reply",
            description: (error as Error).message || 'Please try again.',
            variant: 'error',
          })
          resetStreamingState(runIdCounter)
        })
    },
    [activeConversationId, handleAgentEvent, resetStreamingState, storageMode],
  )

  const startStream = useCallback(
    (args: StartStreamArgs) => {
      if (!activeConversationId) {
        return
      }

      const runId = streamRunIdRef.current + 1
      streamRunIdRef.current = runId
      resetStreamingText()
      resetReasoningText()
      setIsStreaming(true)
      setPendingUserMessageId(args.userMessageId)

      if (agentStreamCleanupRef.current) {
        agentStreamCleanupRef.current()
        agentStreamCleanupRef.current = null
      }

      if (!window.electronAPI?.agent.healthCheck) {
        console.error('[chat] Local agent not available (no electronAPI)')
        showToast({ title: 'Stella agent is not running', variant: 'error' })
        resetStreamingState(runId)
        return
      }

      void window.electronAPI.agent
        .healthCheck()
        .then(async (health) => {
          if (runId !== streamRunIdRef.current) return

          let nextHealth = health
          let reason = getAgentHealthReason(nextHealth)

          if (!nextHealth?.ready && isTokenSyncIssue(reason)) {
            const synced = await trySyncHostToken()
            if (runId !== streamRunIdRef.current) return

            if (synced && window.electronAPI?.agent.healthCheck) {
              nextHealth = await window.electronAPI.agent.healthCheck()
              if (runId !== streamRunIdRef.current) return
              reason = getAgentHealthReason(nextHealth)
            }
          }

          if (!nextHealth?.ready) {
            console.error('[chat] Local agent health check failed:', nextHealth)
            const toast = resolveAgentNotReadyToast(reason)
            showToast({
              title: toast.title,
              description: toast.description,
              variant: 'error',
            })
            resetStreamingState(runId)
            return
          }

          startLocalStream(args, runId)
        })
        .catch((error) => {
          if (runId !== streamRunIdRef.current) return

          console.error('[chat] Local agent health check error:', (error as Error).message)
          showToast({ title: 'Stella agent is not responding', variant: 'error' })
          resetStreamingState(runId)
        })
    },
    [
      activeConversationId,
      resetReasoningText,
      resetStreamingState,
      resetStreamingText,
      startLocalStream,
    ],
  )

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
  })

  return {
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
    startStream,
    cancelCurrentStream,
    resetStreamingState,
  }
}
