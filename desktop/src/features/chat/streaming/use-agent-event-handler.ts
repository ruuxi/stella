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
  fallbackTaskDescription,
  normalizeTaskDisplayStatusText,
  TASK_COMPLETION_INDICATOR_MS,
} from '@/features/chat/lib/event-transforms'
import { showToast } from '@/ui/toast'
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from '../../../../../runtime/contracts/agent-runtime.js'
import { toRunTaskId, type StreamStoreAction } from './store'
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from './stella-provider-error-toast'
import type {
  AgentResponseTarget,
  AgentStreamEvent,
} from './streaming-types'

type ReasoningQueueEntry = {
  runId: string
  conversationId: string
  userMessageId?: string
  agentId: string
  description?: string
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
    resumeSeqByConversationRef: MutableRefObject<Map<string, number>>
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
  lifecycle?: {
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
}

type AgentEventSource = 'live' | 'replay'

export function useAgentEventHandler({
  dispatch,
  refs,
  streaming,
  timers,
  reasoning,
  lifecycle,
}: UseAgentEventHandlerOptions) {
  const {
    activeConversationIdRef,
    activeRunIdByConversationRef,
    lastSeqByConversationRef,
    resumeSeqByConversationRef,
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
  } = streaming
  const { scheduleTaskRemoval, clearScheduledTaskRemoval } = timers
  const {
    queueAgentReasoningChunk,
    flushPendingReasoningChunks,
    discardPendingReasoningChunks,
  } = reasoning

  return useCallback(
    (event: AgentStreamEvent, source: AgentEventSource = 'live') => {
      const conversationId =
        event.conversationId ?? activeConversationIdRef.current ?? null
      if (!conversationId) {
        return
      }

      const seq = Number.isFinite(event.seq) ? event.seq : 0
      if (seq > 0) {
        const previousResumeSeq =
          resumeSeqByConversationRef.current.get(conversationId) ?? 0
        if (seq > previousResumeSeq) {
          resumeSeqByConversationRef.current.set(conversationId, seq)
        }
      }
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
        lifecycle?.onRunFinished?.({
          runId: event.runId,
          conversationId,
          ...(event.userMessageId
            ? { userMessageId: event.userMessageId }
            : {}),
          outcome: args.outcome,
        })
        if (
          conversationId === activeConversationIdRef.current &&
          source === 'live'
        ) {
          const finishReason = args.reason || event.error
          if (args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR) {
            showToast(resolveStellaProviderErrorToast(finishReason))
          } else if (
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED &&
            isStellaLimitOrAuthReason(finishReason)
          ) {
            // A run that *stops mid-flight* because the user ran out of free
            // anonymous previews / hit a usage limit can surface as a cancel
            // rather than an error. Without this the user is left staring at a
            // halted agent with no explanation — the sign-in toast otherwise
            // only appeared the next time they sent a message. Only toast when
            // the reason actually names a limit/auth issue so ordinary
            // user-initiated cancels stay silent.
            showToast(resolveStellaProviderErrorToast(finishReason))
          }
        }
        if (
          conversationId === activeConversationIdRef.current &&
          (args.outcome === AGENT_RUN_FINISH_OUTCOMES.COMPLETED ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED)
        ) {
          if (
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR
          ) {
            // Hard cancel/error: the runtime may not persist an
            // assistant_message for the in-flight slot. Drop the live
            // overlay so a failed turn does not leave a partial assistant
            // message in chat.
            dropOverlaysForRun(event.runId)
          } else {
            // Finalize the current overlay slot. Overlay entries stay
            // in the array until their persisted counterparts land via
            // `chat:localUpdated` (see the dedupe in
            // `useConversationDisplayMessages`).
            finalizeRunOnFinish({ runId: event.runId })
          }
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
          lifecycle?.onRunStarted?.({
            runId: event.runId,
            conversationId,
            ...(event.userMessageId
              ? { userMessageId: event.userMessageId }
              : {}),
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
            // Anchorless runs (proactive / non-`user_turn` responses that
            // never create an overlay row, and therefore never paint via
            // `StreamingTextReveal`) have no paint signal to hand off to, so
            // they still flip the indicator on first delta. Anchored runs
            // instead wait for the reveal frontier to actually paint the
            // first character (`notifyAssistantTextPainted` →
            // `mark-streaming-text`), so the indicator never disappears into
            // a dead gap before any text is visible.
            if (/\S/.test(event.chunk) && !event.userMessageId) {
              dispatch({ type: 'mark-streaming-text', runId: event.runId })
            }
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE: {
          // Boundary between two assistant messages within the same run
          // (e.g. preamble finalized → post-tool answer about to stream).
          // Lock the current overlay slot's text and advance the
          // per-turn slot index so the next chunk lands on a fresh
          // slot. The locked slot stays visible in the chat even after
          // its persisted counterpart lands; the display merge masks
          // the persisted twin and borrows its metadata.
          if (
            (isPrimaryRun || isOrchestratorEvent) &&
            conversationId === activeConversationIdRef.current
          ) {
            finalizeMessageBoundary({
              runId: event.runId,
              userMessageId: event.userMessageId ?? null,
            })
            // Preamble → tool-call handoff: if this finalized message ends
            // with a tool call, clear the streaming-text flag now so the
            // working indicator re-appears at the boundary and stays up
            // across the gap until `tool-start` arrives, instead of
            // lingering dismissed over the painted preamble text.
            if (event.followedByToolCall) {
              dispatch({
                type: 'assistant-message-boundary',
                runId: event.runId,
                followedByToolCall: true,
              })
            }
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.STATUS: {
          if (event.statusState === 'model-fallback') {
            // The engine swapped the model out from under the user — either
            // the stella engine's Fable 5 -> Opus 4.8 safety retry or Claude
            // Code's --fallback-model overload switch. The configured model
            // is not the one answering, so make the switch visible.
            if (conversationId === activeConversationIdRef.current) {
              showToast({
                title: 'Switched to a fallback model',
                description:
                  event.statusText ||
                  'The configured model was unavailable, so this session switched to a fallback model.',
                variant: 'error',
                duration: 10000,
              })
            }
            break
          }
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
          dispatch({
            type: 'tool-activity-observed',
            runId,
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
              description: event.description,
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
              description:
                event.description ?? fallbackTaskDescription(event.agentId),
              agentType: event.agentType || AGENT_IDS.GENERAL,
              status:
                event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED
                  ? 'completed'
                  : 'running',
              anchorTurnId: event.userMessageId,
              parentAgentId: event.parentAgentId,
              groupKey: event.groupKey,
              groupLabel: event.groupLabel,
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
        case AGENT_STREAM_EVENT_TYPES.TOOL_START: {
          dispatch({
            type: 'tool-start',
            runId: event.runId,
            conversationId,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.toolName ? { toolName: event.toolName } : {}),
            statusText: event.statusText ?? null,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.TOOL_END: {
          dispatch({
            type: 'tool-end',
            runId: event.runId,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.toolName ? { toolName: event.toolName } : {}),
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED: {
          applyRunFinished({
            outcome: event.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: event.reason ?? event.error,
          })
          break
        }
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
      lifecycle,
      pendingRequestIdsRef,
      queueAgentReasoningChunk,
      resumeSeqByConversationRef,
      scheduleTaskRemoval,
      setPendingUserMessageId,
      terminalRunIdsRef,
      terminalTaskKeysRef,
    ],
  )
}
