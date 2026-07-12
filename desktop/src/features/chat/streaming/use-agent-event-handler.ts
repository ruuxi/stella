/**
 * Translates inbound `AgentStreamEvent`s into reducer actions + side
 * effects (toasts, per-slot overlay pushes, response target).
 *
 * The dedup/ordering refs and dispatch are passed in (see the options
 * type) so the hook can be composed with the rest of
 * `useLocalAgentStream` without duplicating the reducer's source of
 * truth. Per-thread task decoration writes go straight to the module
 * `task-decoration-store`, not through the reducer. The slot-management callbacks (`beginStreamingRun`,
 * `acceptStreamChunk`, `finalizeMessageBoundary`,
 * `finalizeRunOnFinish`) own the in-memory
 * `streamingAssistants` overlay array — see `useLocalAgentStream` for
 * the lifecycle, and `useConversationDisplayMessages` for the merge
 * with persisted SQLite-backed messages.
 */
import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import { showToast } from '@/ui/toast'
import {
  clearTaskDecoration,
  decorateTask,
} from './task-decoration-store'
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from '../../../../../runtime/contracts/agent-runtime.js'
import type { StreamStoreAction } from './store'
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from './stella-provider-error-toast'
import type {
  AgentResponseTarget,
  AgentStreamEvent,
} from './streaming-types'

type ReasoningQueueEntry = {
  agentId: string
  conversationId: string
  runId?: string
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
    pendingRequestIdsRef: MutableRefObject<Set<string>>
    resumeSeqByConversationRef: MutableRefObject<Map<string, number>>
    seenSourceEventKeysRef: MutableRefObject<Set<string>>
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
     *   - RUN_FINISHED → finalizeRunOnFinish
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
      canonicalMessageId?: string
      canonicalText?: string
    }) => void
    finalizeRunOnFinish: (args: { runId: string }) => void
  }
  reasoning: {
    queueAgentReasoningChunk: (entry: ReasoningQueueEntry) => void
    flushPendingReasoningChunks: (onlyAgentId?: string) => void
    discardPendingReasoningChunks: (agentId: string) => void
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

/**
 * Main-process `agent:event` sequences are globally monotonic, including the
 * Date.now-scale values assigned by `createMonotonicSeqGenerator`. Live
 * delivery and an in-flight resume response can contain the same event, so all
 * positive sequences must participate in deduplication.
 */
export const acceptConversationAgentEventSequence = (
  lastSeqByConversation: Map<string, number>,
  conversationId: string,
  seq: number,
): boolean => {
  if (!Number.isFinite(seq) || seq <= 0) return true
  const previousSeq = lastSeqByConversation.get(conversationId) ?? 0
  if (seq <= previousSeq) return false
  lastSeqByConversation.set(conversationId, seq)
  return true
}

export const acceptAgentEventSourceIdentity = (
  seenKeys: Set<string>,
  event: Pick<AgentStreamEvent, 'type' | 'runId' | 'seq' | 'sourceSeq'>,
): boolean => {
  const sourceSeq = event.sourceSeq ?? event.seq
  if (!Number.isFinite(sourceSeq) || sourceSeq <= 0) return true
  const key = `${event.runId}:${sourceSeq}:${event.type}`
  if (seenKeys.has(key)) return false
  seenKeys.add(key)
  return true
}

export function useAgentEventHandler({
  dispatch,
  refs,
  streaming,
  reasoning,
  lifecycle,
}: UseAgentEventHandlerOptions) {
  const {
    activeConversationIdRef,
    activeRunIdByConversationRef,
    lastSeqByConversationRef,
    resumeSeqByConversationRef,
    seenSourceEventKeysRef,
    terminalRunIdsRef,
    pendingRequestIdsRef,
  } = refs
  const {
    setPendingUserMessageId,
    beginStreamingRun,
    acceptStreamChunk,
    finalizeMessageBoundary,
    finalizeRunOnFinish,
  } = streaming
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
      if (!acceptAgentEventSourceIdentity(seenSourceEventKeysRef.current, event)) {
        return
      }
      if (seq > 0) {
        const previousResumeSeq =
          resumeSeqByConversationRef.current.get(conversationId) ?? 0
        if (seq > previousResumeSeq) {
          resumeSeqByConversationRef.current.set(conversationId, seq)
        }
      }
      if (
        !acceptConversationAgentEventSequence(
          lastSeqByConversationRef.current,
          conversationId,
          seq,
        )
      ) {
        return
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
          // Drain every received character before locking the current slot.
          // This applies to completion, error, and cancel alike: terminal
          // transport state must never silently discard text the provider
          // already delivered. If no persisted twin is written for a failed
          // run, the partial live row remains available until conversation
          // cleanup.
          finalizeRunOnFinish({ runId: event.runId })
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
            // The first accepted text delta starts the visual stream; its
            // first animation frame follows immediately after this handoff.
            if (/\S/.test(event.chunk)) {
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
              ...(event.assistantMessageEventId
                ? { canonicalMessageId: event.assistantMessageEventId }
                : {}),
              ...(event.assistantMessageText !== undefined
                ? { canonicalText: event.assistantMessageText }
                : {}),
            })
            // Preamble → tool-call handoff: if this finalized message ends
            // with a tool call, clear the streaming-text flag now so the
            // working indicator re-appears at the boundary and stays up
            // across the gap until `tool-start` arrives, instead of
            // lingering dismissed over the visible preamble text.
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
          if (!event.agentId) {
            return
          }
          if (runId) {
            dispatch({
              type: 'tool-activity-observed',
              runId,
            })
          }

          // Authoritative thread state (status, description, timestamps,
          // result) rides the thread-activity rows pushed from the
          // runtime's `runtime_agents` table. Stream events only maintain
          // the ephemeral per-thread decoration — statusText ticks, tool
          // activity, reasoning — keyed by the durable agentId, never by
          // run. Terminal events clear the decoration; the row itself
          // turns terminal via the authoritative push.
          if (
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_FAILED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED
          ) {
            discardPendingReasoningChunks(event.agentId)
            clearTaskDecoration(event.agentId)
            break
          }

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING) {
            if (!event.chunk) {
              return
            }
            queueAgentReasoningChunk({
              agentId: event.agentId,
              conversationId,
              runId,
              chunk: event.chunk,
            })
            break
          }

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED) {
            // A fresh start (spawn or send_input re-activation) begins a
            // clean decoration — stale reasoning/status from the previous
            // attempt must not bleed into the new one.
            discardPendingReasoningChunks(event.agentId)
            clearTaskDecoration(event.agentId)
          }

          flushPendingReasoningChunks(event.agentId)
          decorateTask({
            agentId: event.agentId,
            conversationId,
            runId,
            anchorTurnId: event.userMessageId,
            statusText: event.statusText,
            toolActivity: event.toolActivity,
          })
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
      discardPendingReasoningChunks,
      dispatch,
      finalizeMessageBoundary,
      finalizeRunOnFinish,
      flushPendingReasoningChunks,
      lastSeqByConversationRef,
      lifecycle,
      pendingRequestIdsRef,
      queueAgentReasoningChunk,
      resumeSeqByConversationRef,
      seenSourceEventKeysRef,
      setPendingUserMessageId,
      terminalRunIdsRef,
    ],
  )
}
