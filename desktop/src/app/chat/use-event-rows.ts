import { useMemo, useRef } from 'react'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import type { MessagePayload } from '@/app/chat/lib/event-transforms'
import {
  isAssistantMessage,
  isUserMessage,
  isToolRequest,
  isToolResult,
  isAgentCompletedEvent,
} from '@/app/chat/lib/event-transforms'
import { isOfficePreviewRef } from '@/shared/contracts/office-preview'
import { deriveTurnResource } from '@/app/chat/lib/derive-turn-resource'
import { filterEventsForUiDisplay } from '@/app/chat/lib/message-display'
import { isOrchestratorChatMessagePayload } from '@/app/chat/emotes/message-source'
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
  type Selection,
} from './AskQuestionBubble'

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== 'object') return null
  return event.payload as MessagePayload
}

const getWebSearchBadgeHtml = (events: EventRecord[]): string | undefined => {
  for (const event of events) {
    if (event.type !== 'tool_result') continue
    const payload = event.payload as
      | { toolName?: string; html?: unknown; result?: unknown }
      | undefined
    if (!payload || typeof payload.toolName !== 'string') continue
    if (payload.toolName.toLowerCase() !== 'web') continue
    if (typeof payload.html === 'string' && payload.html.trim()) return payload.html
    if (typeof payload.result === 'string' && payload.result.trim())
      return payload.result
  }
  return undefined
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
 * Extract a pending askQuestion (one whose `tool_request` has not yet
 * been answered by an `ask_question_response` user message) plus a map
 * of answered selections keyed by the assistant message id that owned
 * the askQuestion (for inline rendering on the answered assistant row).
 *
 * In the linear timeline an askQuestion sits under whichever assistant
 * message most recently preceded its `tool_request`. That assistant id
 * is what we key by.
 */
type AskQuestionDerivation = {
  pending: AskQuestionState | null
  answeredByAssistantId: Map<string, Record<number, Selection>>
  payloadByAssistantId: Map<string, AskQuestionState>
}

const isAskQuestionResponseMessage = (event: EventRecord): boolean => {
  if (event.type !== 'user_message') return false
  const payload = getMessagePayload(event)
  return (
    payload?.metadata?.trigger?.kind === 'ask_question_response' &&
    payload.metadata.trigger.source === 'ask-question-bubble'
  )
}

const getAskQuestionTargetAgentId = (
  responseTarget: AgentResponseTarget | undefined,
): string | undefined => {
  if (
    responseTarget?.type === 'agent_turn' ||
    responseTarget?.type === 'agent_terminal_notice'
  ) {
    return responseTarget.agentId
  }
  return undefined
}

const deriveAskQuestions = (
  events: EventRecord[],
  responseTargetByAssistantId: Map<string, AgentResponseTarget | undefined>,
): AskQuestionDerivation => {
  const answeredByAssistantId = new Map<string, Record<number, Selection>>()
  const payloadByAssistantId = new Map<string, AskQuestionState>()
  let lastAssistantId: string | null = null
  let pending:
    | { assistantId: string | null; payload: AskQuestionState }
    | null = null

  for (const event of events) {
    if (isAssistantMessage(event)) {
      lastAssistantId = event._id
      continue
    }

    if (event.type === 'user_message') {
      if (isAskQuestionResponseMessage(event) && pending) {
        const text =
          typeof event.payload?.text === 'string' ? event.payload.text : ''
        const selections = parseAskQuestionAnswersMessage(pending.payload, text)
        if (selections && pending.assistantId) {
          answeredByAssistantId.set(pending.assistantId, selections)
        }
        pending = null
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
    pending = { assistantId: lastAssistantId, payload: parsed }
    if (lastAssistantId) {
      payloadByAssistantId.set(lastAssistantId, parsed)
    }
  }

  let pendingState: AskQuestionState | null = null
  if (pending) {
    const targetAgentId = pending.assistantId
      ? getAskQuestionTargetAgentId(
          responseTargetByAssistantId.get(pending.assistantId),
        )
      : undefined
    pendingState = {
      ...pending.payload,
      ...(targetAgentId ? { targetAgentId } : {}),
    }
  }

  return { pending: pendingState, answeredByAssistantId, payloadByAssistantId }
}

type UseEventRowsOptions = {
  events: EventRecord[]
  maxItems?: number
  isStreaming?: boolean
  pendingUserMessageId?: string | null
  selfModMap?: Record<string, SelfModAppliedData>
}

export type UseEventRowsResult = {
  rows: EventRowViewModel[]
  /** Index in `rows` of the last visible user message (-1 if none). */
  lastUserRowIndex: number
  /** Pending askQuestion that has no inline assistant row to attach to. */
  pendingAskQuestion: AskQuestionState | null
  /** Whether to render the streaming tail row. */
  showStreamingTail: boolean
}

export function useEventRows(opts: UseEventRowsOptions): UseEventRowsResult {
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled()
  const {
    events,
    maxItems,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
  } = opts

  const hasAssistantReply = useMemo(
    () =>
      Boolean(
        pendingUserMessageId &&
          events.some(
            (event) =>
              event.type === 'assistant_message' &&
              (event.payload as { userMessageId?: string } | null)
                ?.userMessageId === pendingUserMessageId,
          ),
      ),
    [events, pendingUserMessageId],
  )

  const showStreamingTail = Boolean(
    !hasAssistantReply && isStreaming,
  )

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
    return byAssistantId
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
        const row: UserRowViewModel = {
          kind: 'user',
          id: event._id,
          text: getDisplayUserText(event),
          ...(windowLabel ? { windowLabel } : {}),
          ...(windowPreviewImageUrl ? { windowPreviewImageUrl } : {}),
          attachments: getAttachments(event),
          ...(getChannelEnvelope(event)
            ? { channelEnvelope: getChannelEnvelope(event) }
            : {}),
        }
        computed.push(row)
        continue
      }

      if (isAssistantMessage(event)) {
        const text = getDisplayMessageText(event)
        const toolEvents = segmentedToolEvents.get(event._id) ?? []
        const responseTarget = responseTargetByAssistantId.get(event._id)
        const emotesEnabled = isOrchestratorChatMessagePayload(
          getMessagePayload(event),
        )
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        )
        const askQuestionPayload = askQuestion.payloadByAssistantId.get(event._id)
        const askQuestionSelections = askQuestion.answeredByAssistantId.get(
          event._id,
        )
        const askQuestionTargetAgentId =
          getAskQuestionTargetAgentId(responseTarget)
        const askQuestionState: AskQuestionState | undefined = askQuestionPayload
          ? {
              ...askQuestionPayload,
              ...(askQuestionTargetAgentId
                ? { targetAgentId: askQuestionTargetAgentId }
                : {}),
              ...(askQuestionSelections
                ? { submitted: true, selections: askQuestionSelections }
                : {}),
            }
          : undefined
        const selfModApplied = selfModMap?.[event._id]
        const row: AssistantRowViewModel = {
          kind: 'assistant',
          id: event._id,
          text,
          emotesEnabled,
          ...(responseTarget ? { responseTarget } : {}),
          ...(getWebSearchBadgeHtml(toolEvents)
            ? { webSearchBadgeHtml: getWebSearchBadgeHtml(toolEvents) }
            : {}),
          ...(getOfficePreviewRef(toolEvents)
            ? { officePreviewRef: getOfficePreviewRef(toolEvents) }
            : {}),
          ...(resourcePayload ? { resourcePayload } : {}),
          ...(selfModApplied ? { selfModApplied } : {}),
          ...(askQuestionState ? { askQuestion: askQuestionState } : {}),
        }
        computed.push(row)
      }
    }

    return computed
  }, [
    askQuestion,
    developerResourcePreviewsEnabled,
    displayEvents,
    responseTargetByAssistantId,
    segmentedToolEvents,
    selfModMap,
  ])

  /* eslint-disable react-hooks/refs --
   * Stable-rows cache; mirrors `stabilizeEventList` usage in the event
   * feed. The ref is only read inside this `useMemo` callback. */
  const rowsStableRef = useRef<StableTurnRowsState<EventRowViewModel> | null>(
    null,
  )

  const stableRows = useMemo(() => {
    const next = stabilizeTurnRows(allRows, rowsStableRef.current, eventRowEqual)
    rowsStableRef.current = next
    return next.result
  }, [allRows])
  /* eslint-enable react-hooks/refs */

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
    pendingAskQuestion: askQuestion.pending,
    showStreamingTail,
  }
}
