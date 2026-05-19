/**
 * Translates inbound `AgentStreamEvent`s into reducer actions + side
 * effects (toasts, per-slot overlay pushes, response target).
 *
 * Refs (`activeConversationIdRef`, `activeRunIdByConversationRef`,
 * `lastSeqByConversationRef`, `terminalRunIdsRef`,
 * `terminalTaskKeysRef`, `pendingRequestIdsRef`) and dispatch are
 * passed in so the hook can be composed with the rest of
 * `useLocalAgentStream` without duplicating the reducer's source of
 * truth. The slot-management callbacks (`beginStreamingRun`,
 * `acceptStreamChunk`, `finalizeMessageBoundary`,
 * `finalizeRunOnFinish`, `dropOverlaysForRun`) own the in-memory
 * `streamingAssistants` overlay array — see `useLocalAgentStream` for
 * the lifecycle, and `useConversationDisplayMessages` for the merge
 * with persisted SQLite-backed messages.
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
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>
    /**
     * Hooks into the per-slot overlay lifecycle exposed by
     * `useLocalAgentStream`. Each runtime stream event maps onto
     * exactly one of these so the in-memory `streamingAssistants`
     * array stays consistent with the runtime's view of the world:
     *
     *   - RUN_STARTED  → beginStreamingRun
     *   - STREAM       → acceptStreamChunk
     *   - ASSISTANT_MESSAGE boundary → finalizeMessageBoundary
     *   - RUN_FINISHED → finalizeRunOnFinish (+ dropOverlaysForRun
     *                    on hard-cancel paths)
     */
    beginStreamingRun: (args: {
      runId: string
      userMessageId: string | null
    }) => void
    acceptStreamChunk: (args: {
      runId: string
      userMessageId: string | null
      responseTarget?: AgentResponseTarget | null
      chunk: string
    }) => void
    finalizeMessageBoundary: (args: {
      runId: string
      userMessageId: string | null
    }) => void
    finalizeRunOnFinish: (args: { runId: string }) => void
    dropOverlaysForRun: (runId: string | null) => void
    resetReasoningText: () => void
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
    setPendingUserMessageId,
    beginStreamingRun,
    acceptStreamChunk,
    finalizeMessageBoundary,
    finalizeRunOnFinish,
    dropOverlaysForRun,
    resetReasoningText,
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
      // Synthetic seqs (used by sub-agent lifecycle events and hidden
      // → visible mirror events on the worker, generated as
      // `Date.now() + n`) are orders of magnitude larger than the
      // recorder's per-run seqs (which start at 1 and increment per
      // event). If we let a synthetic seq advance the conversation
      // cursor, every subsequent recorder-seq event in the same
      // conversation — including the orchestrator's post-tool
      // `STREAM` chunks — fails the `seq > previousSeq` check and
      // gets silently dropped, which manifests as "no live streaming
      // after a tool, message just pops in fully when done".
      //
      // Threshold: recorder seqs are bounded by event count per run
      // (a few thousand at most); `Date.now()` floors at ~1.78e12.
      // Anything past 1e10 is unambiguously synthetic — let it
      // through but don't touch the cursor.
      const SYNTHETIC_SEQ_FLOOR = 1e10
      if (seq > 0 && seq < SYNTHETIC_SEQ_FLOOR) {
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
        if (
          conversationId === activeConversationIdRef.current &&
          (args.outcome === AGENT_RUN_FINISH_OUTCOMES.COMPLETED ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED)
        ) {
          if (args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED) {
            // Hard cancel: the runtime may not persist an
            // assistant_message for the in-flight slot, so leaving the
            // overlay around would linger forever. Drop everything
            // tied to this run.
            dropOverlaysForRun(event.runId)
          } else {
            // Finalize the current overlay slot so its text equals the
            // full received text (smoothing drain). Overlay entries
            // stay in the array until their persisted counterparts
            // land via `chat:localUpdated` (see the dedupe in
            // `useConversationDisplayMessages`).
            finalizeRunOnFinish({ runId: event.runId })
          }
          resetReasoningText()
          setPendingUserMessageId(null)
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
            const anchorUserMessageId =
              event.responseTarget && event.responseTarget.type !== 'user_turn'
                ? null
                : (event.userMessageId ?? null)
            beginStreamingRun({
              runId: event.runId,
              userMessageId: anchorUserMessageId,
            })
            resetReasoningText()
            setPendingUserMessageId(anchorUserMessageId)
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
            beginStreamingRun({
              runId: event.runId,
              userMessageId: event.userMessageId ?? null,
            })
            resetReasoningText()
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
            acceptStreamChunk({
              runId: event.runId,
              userMessageId: event.userMessageId ?? null,
              ...(event.responseTarget
                ? { responseTarget: event.responseTarget }
                : {}),
              chunk: event.chunk,
            })
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE: {
          // Boundary between two assistant messages within the same run
          // (e.g. preamble finalized → post-tool answer about to stream).
          // Lock the current overlay slot's text (smoothing drain) and
          // advance the per-turn slot index so the next chunk lands on
          // a fresh slot. The locked slot stays visible in the chat
          // until its persisted counterpart lands via
          // `chat:localUpdated` and the merge dedupe in
          // `useConversationDisplayMessages` filters it out.
          if (
            (isPrimaryRun || isOrchestratorEvent) &&
            conversationId === activeConversationIdRef.current
          ) {
            finalizeMessageBoundary({
              runId: event.runId,
              userMessageId: event.userMessageId ?? null,
            })
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
      acceptStreamChunk,
      activeConversationIdRef,
      activeRunIdByConversationRef,
      beginStreamingRun,
      clearScheduledTaskRemoval,
      discardPendingReasoningChunks,
      dispatch,
      dropOverlaysForRun,
      finalizeMessageBoundary,
      finalizeRunOnFinish,
      flushPendingReasoningChunks,
      lastSeqByConversationRef,
      pendingRequestIdsRef,
      queueAgentReasoningChunk,
      resetReasoningText,
      scheduleTaskRemoval,
      setPendingUserMessageId,
      terminalRunIdsRef,
      terminalTaskKeysRef,
    ],
  )
}
