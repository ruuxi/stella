import { useLayoutEffect, useMemo, useRef } from 'react'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import type { MessagePayload } from '@/app/chat/lib/event-transforms'
import {
  isAssistantMessage,
  isUserMessage,
  isToolRequest,
  isToolResult,
  isAgentCompletedEvent,
} from '@/app/chat/lib/event-transforms'
import { isOfficePreviewRef } from '../../../../runtime/contracts/office-preview.js'
import type { ScheduleToolAffectedRef } from '../../../../runtime/kernel/shared/scheduling'
import {
  collectTurnSourceDiffPayloads,
  deriveTurnResource,
} from '@/app/chat/lib/derive-turn-resource'
import { filterEventsForUiDisplay } from '@/app/chat/lib/message-display'
import {
  stabilizeTurnRows,
  type StableTurnRowsState,
} from '@/app/chat/lib/stable-rows'
import { eventRowEqual } from '@/app/chat/lib/row-equality'
import { useDeveloperResourcePreviewsEnabled } from '@/shared/lib/developer-resource-previews'
import type {
  AssistantRowViewModel,
  EventRowViewModel,
  UserRowViewModel,
} from './MessageRow'
import {
  getDisplayMessageText,
  getDisplayUserText,
  getAttachments,
  getChannelEnvelope,
} from './lib/message-turn-display'
import type { SelfModAppliedData } from '@/app/chat/streaming/streaming-types'
import type { AgentResponseTarget } from '@/app/chat/streaming/streaming-types'
import {
  parseAskQuestionArgs,
  parseAskQuestionAnswersMessage,
  type AskQuestionState,
} from './AskQuestionBubble'
import { isUiHiddenMessagePayload } from '@/app/chat/lib/message-display'

type Selection = NonNullable<AskQuestionState["selections"]>[number]

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== 'object') return null
  return event.payload as MessagePayload
}

const getOfficePreviewRef = (events: EventRecord[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_result') continue
    const payload = event.payload as { officePreviewRef?: unknown } | undefined
    if (isOfficePreviewRef(payload?.officePreviewRef)) return payload.officePreviewRef
  }
  return undefined
}

/**
 * Pick out the latest `Schedule` tool_result on this assistant turn and
 * lift its structured `details.schedule.affected` payload (see
 * `ScheduleToolDetails` in `runtime/kernel/shared/scheduling.ts`). Returns
 * `undefined` for turns that didn't go through the Schedule tool, or
 * Schedule turns whose subagent reported "no_change".
 */
const getScheduleReceipt = (
  events: EventRecord[],
):
  | { affected: ScheduleToolAffectedRef[]; summary?: string }
  | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_result') continue
    const payload = event.payload as
      | {
          toolName?: string
          error?: string
          schedule?: { affected?: unknown }
          resultPreview?: unknown
          result?: unknown
        }
      | undefined
    if (!payload || payload.toolName !== 'Schedule') continue
    if (typeof payload.error === 'string' && payload.error) return undefined
    const schedule = payload.schedule
    if (!schedule || typeof schedule !== 'object') continue
    const affected = (schedule as { affected?: unknown }).affected
    if (!Array.isArray(affected) || affected.length === 0) continue
    const summary =
      typeof payload.resultPreview === 'string' && payload.resultPreview.trim()
        ? payload.resultPreview.trim()
        : typeof payload.result === 'string' && payload.result.trim()
          ? payload.result.trim()
          : undefined
    return {
      affected: affected as ScheduleToolAffectedRef[],
      ...(summary ? { summary } : {}),
    }
  }
  return undefined
}

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

const getCwd = (events: EventRecord[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_request') continue
    const payload = event.payload as { args?: unknown } | undefined
    if (!payload?.args || typeof payload.args !== 'object') continue
    const args = payload.args as Record<string, unknown>
    const cwd =
      asNonEmptyString(args.working_directory) ??
      asNonEmptyString(args.workdir) ??
      asNonEmptyString(args.cwd)
    if (cwd) return cwd
  }
  return undefined
}

/**
 * Walk the event stream once and produce everything the chat surface
 * needs to render askQuestion bubbles in a single, stable place per
 * question:
 *
 *  - `payloadByAssistantId`: for every askQuestion we've seen, the
 *    full payload (with optional `submitted`/`selections`) keyed by the
 *    assistant message it should attach to. Includes both pending and
 *    answered questions.
 *  - `standaloneByUserId`: askQuestions with no preceding assistant
 *    message, keyed by the visible user message that triggered them.
 *    Rendering them as rows immediately after that user message keeps
 *    answered summaries exactly where the question appeared, even after
 *    later assistant messages stream in.
 *  - `pendingWithoutAnchor`: rare fallback for a question with neither
 *    an assistant nor visible user anchor.
 *
 * Resolving the originating assistant skips agent-terminal-notice
 * messages so the bubble doesn't get parked on an "Agent completed"
 * row when there's a real chat reply available.
 *
 * The main chat does not infer routing from active sub-agents. A Store
 * agent can use askQuestion only from its own Store-specific surface;
 * the orchestrator chat answer path stays local to the current chat.
 */
type AskQuestionDerivation = {
  payloadByAssistantId: Map<string, AskQuestionState>
  standaloneByUserId: Map<string, AskQuestionState>
  pendingWithoutAnchor: AskQuestionState | null
}

const isAskQuestionResponseMessage = (event: EventRecord): boolean => {
  if (event.type !== 'user_message') return false
  const payload = getMessagePayload(event)
  return (
    payload?.metadata?.trigger?.kind === 'ask_question_response' &&
    payload.metadata.trigger.source === 'ask-question-bubble'
  )
}

const isTerminalNoticeAssistant = (
  responseTarget: AgentResponseTarget | undefined,
): boolean => responseTarget?.type === 'agent_terminal_notice'

const deriveAskQuestions = (
  events: EventRecord[],
  responseTargetByAssistantId: Map<string, AgentResponseTarget | undefined>,
): AskQuestionDerivation => {
  const payloadByAssistantId = new Map<string, AskQuestionState>()
  const standaloneByUserId = new Map<string, AskQuestionState>()
  let pendingWithoutAnchor: AskQuestionState | null = null

  /** Originating assistant for the most recent unanswered question, if any. */
  let lastNonNoticeAssistantId: string | null = null
  let lastVisibleUserId: string | null = null
  let pending:
    | {
        assistantId: string | null
        userId: string | null
        payload: AskQuestionState
      }
    | null = null

  const finalize = (
    assistantId: string | null,
    userId: string | null,
    payload: AskQuestionState,
    selections: Record<number, Selection> | null,
  ) => {
    const state: AskQuestionState = {
      ...payload,
      ...(selections ? { submitted: true, selections } : {}),
    }
    if (assistantId) {
      payloadByAssistantId.set(assistantId, state)
    } else if (userId) {
      standaloneByUserId.set(userId, state)
    } else {
      pendingWithoutAnchor = state
    }
  }

  for (const event of events) {
    if (isAssistantMessage(event)) {
      const responseTarget = responseTargetByAssistantId.get(event._id)
      if (!isTerminalNoticeAssistant(responseTarget)) {
        lastNonNoticeAssistantId = event._id
      }
      continue
    }

    if (event.type === 'user_message') {
      if (isAskQuestionResponseMessage(event) && pending) {
        const text =
          typeof event.payload?.text === 'string' ? event.payload.text : ''
        const selections = parseAskQuestionAnswersMessage(pending.payload, text)
        finalize(
          pending.assistantId,
          pending.userId,
          pending.payload,
          selections,
        )
        pending = null
        continue
      }
      // A visible user message marks a real turn boundary. A subsequent
      // askQuestion belongs to *this* turn, not the previous turn's
      // assistant message — drop the stale candidate so the bubble
      // either attaches to a fresh assistant emitted later in this turn
      // or, if the agent's first action is the question, falls through
      // to the standalone PendingAskQuestionRow at the tail.
      // Hidden user messages (system reminders, workspace creation
      // requests, etc.) don't visually break the turn so they shouldn't
      // discard the candidate.
      if (!isUiHiddenMessagePayload(getMessagePayload(event))) {
        lastNonNoticeAssistantId = null
        lastVisibleUserId = event._id
      }
      continue
    }

    if (event.type !== 'tool_request') continue
    const payload = event.payload as
      | { toolName?: string; args?: unknown }
      | undefined
    if (payload?.toolName !== 'askQuestion') continue
    const parsed = parseAskQuestionArgs(payload.args)
    if (!parsed) continue
    const assistantId = lastNonNoticeAssistantId
    pending = {
      assistantId,
      userId: assistantId ? null : lastVisibleUserId,
      payload: parsed,
    }
  }

  if (pending) {
    finalize(pending.assistantId, pending.userId, pending.payload, null)
  }

  return { payloadByAssistantId, standaloneByUserId, pendingWithoutAnchor }
}

type UseEventRowsOptions = {
  events: EventRecord[]
  maxItems?: number
  isStreaming?: boolean
  pendingUserMessageId?: string | null
  /**
   * Live streaming buffer for the in-flight assistant reply. Overlaid
   * onto the assistant row that responds to `pendingUserMessageId` so
   * there is no separate "streaming tail" row to swap in/out at finish.
   */
  streamingText?: string
  selfModMap?: Record<string, SelfModAppliedData>
}

type UseEventRowsResult = {
  rows: EventRowViewModel[]
  /** Index in `rows` of the last visible user message (-1 if none). */
  lastUserRowIndex: number
  /** Rare pending askQuestion with no row anchor. */
  pendingAskQuestion: AskQuestionState | null
}

const assistantKeyFor = (userMessageId: string) =>
  `assistant-for-${userMessageId}`

export const segmentToolEventsByAssistant = (events: EventRecord[]) => {
  const byAssistantId = new Map<string, EventRecord[]>()
  let buffer: EventRecord[] = []
  for (const event of events) {
    if (isAssistantMessage(event)) {
      byAssistantId.set(event._id, buffer)
      buffer = []
      continue
    }
    if (
      isToolRequest(event) ||
      isToolResult(event) ||
      isAgentCompletedEvent(event)
    ) {
      buffer.push(event)
    }
  }
  return { byAssistantId, trailing: buffer }
}

const stableToolSegmentKey = (events: EventRecord[]): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (typeof event.requestId === 'string' && event.requestId.trim()) {
      return event.requestId.trim()
    }
  }
  const last = events[events.length - 1]
  return last?._id ?? 'trailing'
}

export function useEventRows(opts: UseEventRowsOptions): UseEventRowsResult {
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled()
  const {
    events,
    maxItems,
    isStreaming,
    pendingUserMessageId,
    streamingText,
    selfModMap,
  } = opts

  const displayEvents = useMemo(
    () => filterEventsForUiDisplay(events),
    [events],
  )

  /**
   * Walk the full (non-display-filtered) event stream so tool events that
   * landed between visible messages are still grouped by which assistant
   * row they belong to (the assistant that closed the segment they were
   * collected during).
   */
  const segmentedToolEvents = useMemo(() => {
    return segmentToolEventsByAssistant(events)
  }, [events])

  const responseTargetByAssistantId = useMemo(() => {
    const map = new Map<string, AgentResponseTarget | undefined>()
    for (const event of events) {
      if (!isAssistantMessage(event)) continue
      const metadata = (
        getMessagePayload(event)?.metadata as
          | { runtime?: { responseTarget?: AgentResponseTarget } }
          | undefined
      )?.runtime
      map.set(event._id, metadata?.responseTarget)
    }
    return map
  }, [events])

  const askQuestion = useMemo(
    () => deriveAskQuestions(events, responseTargetByAssistantId),
    [events, responseTargetByAssistantId],
  )

  const allRows = useMemo<EventRowViewModel[]>(() => {
    const computed: EventRowViewModel[] = []
    /**
     * Tracks the first assistant row seen per `userMessageId` so it
     * "owns" the stable `assistant-for-<uid>` key. Any later assistant
     * messages tied to the same user turn (e.g. agent terminal notices)
     * fall back to their own event id.
     */
    const primaryAssistantByUserMessageId = new Set<string>()
    let pendingAssistantWasProjected = false

    for (const event of displayEvents) {
      if (isUserMessage(event)) {
        const contextMetadata = getMessagePayload(event)?.metadata?.context
        const windowLabel =
          typeof contextMetadata?.windowLabel === 'string' &&
          contextMetadata.windowLabel.trim()
            ? contextMetadata.windowLabel.trim()
            : undefined
        const windowPreviewImageUrl =
          typeof contextMetadata?.windowPreviewImageUrl === 'string' &&
          contextMetadata.windowPreviewImageUrl.trim()
            ? contextMetadata.windowPreviewImageUrl.trim()
            : undefined
        const appSelectionLabel =
          typeof contextMetadata?.appSelectionLabel === 'string' &&
          contextMetadata.appSelectionLabel.trim()
            ? contextMetadata.appSelectionLabel.trim()
            : undefined
        const row: UserRowViewModel = {
          kind: 'user',
          id: event._id,
          text: getDisplayUserText(event),
          ...(windowLabel ? { windowLabel } : {}),
          ...(windowPreviewImageUrl ? { windowPreviewImageUrl } : {}),
          ...(appSelectionLabel ? { appSelectionLabel } : {}),
          attachments: getAttachments(event),
          ...(getChannelEnvelope(event)
            ? { channelEnvelope: getChannelEnvelope(event) }
            : {}),
        }
        computed.push(row)
        const standaloneAskQuestion = askQuestion.standaloneByUserId.get(event._id)
        if (standaloneAskQuestion) {
          const stableKey = `ask-question-for-${event._id}`
          computed.push({
            kind: 'assistant',
            id: stableKey,
            text: '',
            cacheKey: stableKey,
            askQuestion: standaloneAskQuestion,
          })
        }
        continue
      }

      if (isAssistantMessage(event)) {
        const persistedText = getDisplayMessageText(event)
        const payload = getMessagePayload(event)
        const replyToUserMessageId =
          typeof payload?.userMessageId === 'string' &&
          payload.userMessageId.length > 0
            ? payload.userMessageId
            : undefined
        const isPrimaryReply =
          replyToUserMessageId !== undefined &&
          !primaryAssistantByUserMessageId.has(replyToUserMessageId)
        if (isPrimaryReply && replyToUserMessageId) {
          primaryAssistantByUserMessageId.add(replyToUserMessageId)
        }
        const isPendingReply =
          isPrimaryReply &&
          replyToUserMessageId !== undefined &&
          replyToUserMessageId === pendingUserMessageId
        if (isPendingReply) {
          pendingAssistantWasProjected = true
        }
        const text =
          isPendingReply && isStreaming
            ? (streamingText ?? '')
            : persistedText
        const isAnimating = Boolean(isPendingReply && isStreaming)
        const stableKey =
          isPrimaryReply && replyToUserMessageId
            ? assistantKeyFor(replyToUserMessageId)
            : event._id
        const toolEvents =
          segmentedToolEvents.byAssistantId.get(event._id) ?? []
        const responseTarget = responseTargetByAssistantId.get(event._id)
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        )
        const sourceDiffPayloads = collectTurnSourceDiffPayloads(toolEvents, {
          developerResourcesEnabled: developerResourcePreviewsEnabled,
        })
        const askQuestionState = askQuestion.payloadByAssistantId.get(event._id)
        const selfModApplied = selfModMap?.[event._id]
        const row: AssistantRowViewModel = {
          kind: 'assistant',
          id: stableKey,
          text,
          cacheKey: stableKey,
          ...(isAnimating ? { isAnimating: true } : {}),
          ...(responseTarget ? { responseTarget } : {}),
          ...(getOfficePreviewRef(toolEvents)
            ? { officePreviewRef: getOfficePreviewRef(toolEvents) }
            : {}),
          ...(resourcePayload ? { resourcePayload } : {}),
          ...(sourceDiffPayloads.length > 0 ? { sourceDiffPayloads } : {}),
          ...(selfModApplied ? { selfModApplied } : {}),
          ...(getScheduleReceipt(toolEvents)
            ? { scheduleReceipt: getScheduleReceipt(toolEvents) }
            : {}),
          ...(askQuestionState ? { askQuestion: askQuestionState } : {}),
        }
        computed.push(row)
      }
    }

    const trailingResourcePayload = deriveTurnResource(
      segmentedToolEvents.trailing,
      '',
      getCwd(segmentedToolEvents.trailing),
      { developerResourcesEnabled: developerResourcePreviewsEnabled },
    )
    if (
      trailingResourcePayload?.kind === 'media' &&
      trailingResourcePayload.presentation === 'inline-image' &&
      trailingResourcePayload.asset.kind === 'image'
    ) {
      const stableKey = `assistant-tool-resource-${stableToolSegmentKey(
        segmentedToolEvents.trailing,
      )}`
      computed.push({
        kind: 'assistant',
        id: stableKey,
        text: '',
        cacheKey: stableKey,
        resourcePayload: trailingResourcePayload,
      })
    }

    /**
     * No persisted assistant_message has landed yet for the in-flight
     * user turn. Synthesize a placeholder row, keyed identically to the
     * persisted row that will eventually replace it, so React reuses
     * the same component instance (and Streamdown the same parse cache)
     * across the swap — no flash, no remount.
     */
    if (
      pendingUserMessageId &&
      !pendingAssistantWasProjected &&
      (Boolean(isStreaming) ||
        Boolean(streamingText && streamingText.length > 0))
    ) {
      const stableKey = assistantKeyFor(pendingUserMessageId)
      const placeholder: AssistantRowViewModel = {
        kind: 'assistant',
        id: stableKey,
        text: streamingText ?? '',
        cacheKey: stableKey,
        ...(isStreaming ? { isAnimating: true } : {}),
      }
      computed.push(placeholder)
    }

    return computed
  }, [
    askQuestion,
    developerResourcePreviewsEnabled,
    displayEvents,
    isStreaming,
    pendingUserMessageId,
    responseTargetByAssistantId,
    segmentedToolEvents,
    selfModMap,
    streamingText,
  ])

  const rowsStableRef = useRef<StableTurnRowsState<EventRowViewModel> | null>(
    null,
  )

  const stableRowsState = useMemo(
    () => stabilizeTurnRows(allRows, rowsStableRef.current, eventRowEqual),
    [allRows],
  )

  useLayoutEffect(() => {
    rowsStableRef.current = stableRowsState
  }, [stableRowsState])

  const stableRows = stableRowsState.result

  const slicedRows = useMemo(() => {
    if (typeof maxItems !== 'number') return stableRows
    const cap = Math.max(0, Math.floor(maxItems))
    if (cap <= 0) return []
    if (stableRows.length <= cap) return stableRows
    return stableRows.slice(stableRows.length - cap)
  }, [maxItems, stableRows])

  const lastUserRowIndex = useMemo(() => {
    for (let i = slicedRows.length - 1; i >= 0; i -= 1) {
      if (slicedRows[i].kind === 'user') return i
    }
    return -1
  }, [slicedRows])

  return {
    rows: slicedRows,
    lastUserRowIndex,
    pendingAskQuestion: askQuestion.pendingWithoutAnchor,
  }
}
