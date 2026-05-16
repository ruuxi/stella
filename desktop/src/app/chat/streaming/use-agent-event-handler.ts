/**
 * Translates inbound `AgentStreamEvent`s into reducer actions + side
 * effects (toasts, streaming-text accumulator, response target).
 *
 * Refs (`activeConversationIdRef`, `activeRunIdByConversationRef`,
 * `lastSeqByConversationRef`, `terminalRunIdsRef`, `terminalTaskKeysRef`,
 * `pendingRequestIdsRef`) and dispatch are passed in so the hook can be
 * composed with the rest of `useLocalAgentStream` without duplicating
 * the reducer's source of truth.
 */
import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import {
  normalizeTaskDisplayStatusText,
  TASK_COMPLETION_INDICATOR_MS,
} from '@/app/chat/lib/event-transforms'
import { showToast } from '@/ui/toast'
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from '../../../../../runtime/contracts/agent-runtime.js'
import { toRunTaskId, type StreamStoreAction } from './store'
import { resolveStellaProviderErrorToast } from './stella-provider-error-toast'
import type {
  AgentResponseTarget,
  AgentStreamEvent,
} from './streaming-types'

type ReasoningQueueEntry = {
  runId: string
  conversationId: string
  userMessageId?: string
  agentId: string
  chunk: string
}

type UseAgentEventHandlerOptions = {
  dispatch: Dispatch<StreamStoreAction>
  refs: {
    activeConversationIdRef: MutableRefObject<string | null>
    activeRunIdByConversationRef: MutableRefObject<
      Record<string, string | null>
    >
    lastSeqByConversationRef: MutableRefObject<Map<string, number>>
    terminalRunIdsRef: MutableRefObject<Set<string>>
    terminalTaskKeysRef: MutableRefObject<Set<string>>
    pendingRequestIdsRef: MutableRefObject<Set<string>>
  }
  streaming: {
    appendStreamingDelta: (chunk: string) => void
    resetStreamingText: () => void
    resetReasoningText: () => void
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>
    setStreamingResponseTarget: Dispatch<
      React.SetStateAction<AgentResponseTarget | null>
    >
  }
  timers: {
    scheduleTaskRemoval: (
      runId: string,
      agentId: string,
      delayMs: number,
    ) => void
    clearScheduledTaskRemoval: (runId: string, agentId: string) => void
  }
  reasoning: {
    queueAgentReasoningChunk: (entry: ReasoningQueueEntry) => void
    flushPendingReasoningChunks: (onlyKey?: string) => void
    discardPendingReasoningChunks: (runId: string, agentId: string) => void
  }
}

export function useAgentEventHandler({
  dispatch,
  refs,
  streaming,
  timers,
  reasoning,
}: UseAgentEventHandlerOptions) {
  const {
    activeConversationIdRef,
    activeRunIdByConversationRef,
    lastSeqByConversationRef,
    terminalRunIdsRef,
    terminalTaskKeysRef,
    pendingRequestIdsRef,
  } = refs
  const {
    appendStreamingDelta,
    resetStreamingText,
    resetReasoningText,
    setPendingUserMessageId,
    setStreamingResponseTarget,
  } = streaming
  const { scheduleTaskRemoval, clearScheduledTaskRemoval } = timers
  const {
    queueAgentReasoningChunk,
    flushPendingReasoningChunks,
    discardPendingReasoningChunks,
  } = reasoning

  return useCallback(
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
          showToast(resolveStellaProviderErrorToast(args.reason || event.error))
        }
        if (args.outcome !== AGENT_RUN_FINISH_OUTCOMES.COMPLETED) {
          resetStreamingText()
          resetReasoningText()
          setPendingUserMessageId(null)
          setStreamingResponseTarget(null)
        }
        // `selfModApplied` is patched onto the persisted assistant
        // message payload by the worker (`attachSelfModToAssistantMessage`
        // in runtime/worker/server.ts → onEnd). The renderer projects it
        // off the chat row in `use-event-rows.ts`, so we no longer mirror
        // it in renderer-local state.
      }

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.RUN_STARTED: {
          if (event.uiVisibility === 'hidden') {
            break
          }
          if (event.requestId) {
            pendingRequestIdsRef.current.delete(event.requestId)
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
          if (event.statusState === 'provider-retry') {
            if (conversationId === activeConversationIdRef.current) {
              showToast({
                title: 'Reconnecting to Stella',
                description: event.statusText || 'Trying again in a moment.',
                variant: 'default',
                duration: 4000,
              })
            }
            break
          }
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
              statusText: normalizeTaskDisplayStatusText(event.statusText),
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
      activeConversationIdRef,
      activeRunIdByConversationRef,
      appendStreamingDelta,
      clearScheduledTaskRemoval,
      discardPendingReasoningChunks,
      dispatch,
      flushPendingReasoningChunks,
      lastSeqByConversationRef,
      pendingRequestIdsRef,
      queueAgentReasoningChunk,
      resetReasoningText,
      resetStreamingText,
      scheduleTaskRemoval,
      setPendingUserMessageId,
      setStreamingResponseTarget,
      terminalRunIdsRef,
      terminalTaskKeysRef,
    ],
  )
}
