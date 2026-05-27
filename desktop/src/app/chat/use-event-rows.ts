import { useLayoutEffect, useMemo, useRef } from 'react'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import type { MessagePayload } from '@/app/chat/lib/event-transforms'
import {
  isAssistantMessage,
  isUserMessage,
} from '@/app/chat/lib/event-transforms'
import type { MessageRecord } from '../../../../runtime/contracts/local-chat.js'
import { isOfficePreviewRef } from '../../../../runtime/contracts/office-preview.js'
import type { ScheduleToolAffectedRef } from '../../../../runtime/kernel/shared/scheduling'
import {
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
} from '@/app/chat/lib/derive-turn-resource'
import { filterMessagesForUiDisplay } from '@/app/chat/lib/message-display'
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
import {
  assistantScrollFollowKey,
  type AgentResponseTarget,
} from '@/app/chat/streaming/streaming-types'

/**
 * Synthetic `_id` prefix carried by `StreamingAssistantOverlay` rows
 * merged into `displayMessages` by `useConversationDisplayMessages`.
 * The row builder uses this prefix to tag rows as `isStreaming: true`.
 */
const STREAMING_OVERLAY_ID_PREFIX = 'stream-overlay:'
import {
  parseAskQuestionArgs,
  parseAskQuestionAnswersMessage,
  type AskQuestionState,
} from './AskQuestionBubble'
import { isUiHiddenMessagePayload } from '@/app/chat/lib/message-display'

type Selection = NonNullable<AskQuestionState["selections"]>[number]

const getMessagePayload = (
  event?: EventRecord | MessageRecord,
): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== 'object') return null
  return event.payload as MessagePayload
}

const getOfficePreviewRef = (events: readonly EventRecord[]) => {
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
  events: readonly EventRecord[],
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

const getCwd = (events: readonly EventRecord[]): string | undefined => {
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

const isAskQuestionResponseMessage = (message: MessageRecord): boolean => {
  if (message.type !== 'user_message') return false
  const payload = getMessagePayload(message)
  return (
    payload?.metadata?.trigger?.kind === 'ask_question_response' &&
    payload.metadata.trigger.source === 'ask-question-bubble'
  )
}

const isTerminalNoticeAssistant = (
  responseTarget: AgentResponseTarget | undefined,
): boolean => responseTarget?.type === 'agent_terminal_notice'

/**
 * Walk messages (with their owned `toolEvents` inlined chronologically)
 * and route every `askQuestion` tool_request to its render anchor:
 *  - the most recent non-terminal-notice assistant in the same turn, or
 *  - the visible user message above it when no assistant has fired yet
 *    in this turn, or
 *  - the standalone "pending without anchor" tail-row fallback.
 *
 * A `user_message` flagged as `ask_question_response` finalizes the
 * pending question with the selected answers; ordinary visible user
 * messages start a new turn (which discards the prior turn's pending
 * assistant anchor so a fresh question attaches to the new turn).
 */
const deriveAskQuestions = (
  messages: MessageRecord[],
  responseTargetByAssistantId: Map<string, AgentResponseTarget | undefined>,
): AskQuestionDerivation => {
  const payloadByAssistantId = new Map<string, AskQuestionState>()
  const standaloneByUserId = new Map<string, AskQuestionState>()
  let pendingWithoutAnchor: AskQuestionState | null = null

  type Pending = {
    assistantId: string | null
    userId: string | null
    payload: AskQuestionState
  }
  let lastNonNoticeAssistantId: string | null = null
  let lastVisibleUserId: string | null = null
  // `pending` carries the most recent unanswered askQuestion across the
  // message walk. Explicit `Pending | null` annotation (instead of
  // inferred) keeps TS from collapsing the type back to `null` between
  // mutations.
  let pending: Pending | null = null

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

  for (const message of messages) {
    if (isAssistantMessage(message)) {
      const responseTarget = responseTargetByAssistantId.get(message._id)
      if (!isTerminalNoticeAssistant(responseTarget)) {
        lastNonNoticeAssistantId = message._id
      }
    } else if (message.type === 'user_message') {
      const currentPending = pending
      if (isAskQuestionResponseMessage(message) && currentPending) {
        const text =
          typeof (message.payload as { text?: unknown })?.text === 'string'
            ? ((message.payload as { text: string }).text)
            : ''
        const selections = parseAskQuestionAnswersMessage(
          currentPending.payload,
          text,
        )
        finalize(
          currentPending.assistantId,
          currentPending.userId,
          currentPending.payload,
          selections,
        )
        pending = null
      } else if (!isUiHiddenMessagePayload(getMessagePayload(message))) {
        // A visible user message marks a real turn boundary. A
        // subsequent askQuestion belongs to *this* turn, not the prior
        // assistant — drop the stale anchor so the next askQuestion
        // attaches to either a fresh assistant in this turn or, if the
        // agent's first action is the question, the standalone
        // `PendingAskQuestionRow` tail. Hidden user messages (system
        // reminders, workspace creation requests, etc.) don't visually
        // break the turn, so they don't discard the anchor.
        lastNonNoticeAssistantId = null
        lastVisibleUserId = message._id
      }
    }

    for (const toolEvent of message.toolEvents) {
      if (toolEvent.type !== 'tool_request') continue
      const payload = toolEvent.payload as
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
  }

  const tail = pending
  if (tail) {
    finalize(tail.assistantId, tail.userId, tail.payload, null)
  }

  return { payloadByAssistantId, standaloneByUserId, pendingWithoutAnchor }
}

type UseEventRowsOptions = {
  messages: MessageRecord[]
  maxItems?: number
}

type UseEventRowsResult = {
  rows: EventRowViewModel[]
  /** Rare pending askQuestion with no row anchor. */
  pendingAskQuestion: AskQuestionState | null
}

const isImageOnlyInlineRow = (row: AssistantRowViewModel): boolean =>
  row.text.trim().length === 0 &&
  (row.inlineImagePayloads?.length ?? 0) > 0 &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !(row.sourceDiffPayloads?.length) &&
  !row.selfModApplied &&
  !row.scheduleReceipt &&
  !row.askQuestion &&
  !row.customSlot

/** Merge sequential one-by-one image_gen rows into a single inline strip. */
const coalesceInlineImageRows = (
  rows: EventRowViewModel[],
): EventRowViewModel[] => {
  const out: EventRowViewModel[] = []
  for (const row of rows) {
    if (row.kind !== 'assistant' || !isImageOnlyInlineRow(row)) {
      out.push(row)
      continue
    }
    const prev = out[out.length - 1]
    if (
      prev?.kind === 'assistant' &&
      prev.replyToUserMessageId === row.replyToUserMessageId &&
      !prev.officePreviewRef &&
      !prev.resourcePayload &&
      !(prev.sourceDiffPayloads?.length) &&
      !prev.selfModApplied &&
      !prev.scheduleReceipt &&
      !prev.askQuestion &&
      !prev.customSlot
    ) {
      out[out.length - 1] = {
        ...prev,
        inlineImagePayloads: [
          ...(prev.inlineImagePayloads ?? []),
          ...(row.inlineImagePayloads ?? []),
        ],
      }
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * Stable React key for an assistant row. Live-streaming overlays and
 * their eventual persisted counterparts share this key (both anchor
 * on `(userMessageId, indexInTurn)`). While the live overlay is still
 * present it masks the persisted twin; once the overlay is cleared,
 * the persisted row reuses the same key. Preserves the slot's
 * measured size and Streamdown's parse cache across the handoff.
 *
 * Falls back to `message._id` for assistant messages without a
 * `userMessageId` payload field (rare — e.g. legacy rows or hidden
 * runs that surface without a user-message anchor).
 */
/**
 * Stable cache key for a synthetic trailing artifact row (fire-and-
 * forget image emitted before any assistant text). Prefers the latest
 * `requestId` in the segment so a follow-up tool result for the same
 * request reuses the cached row.
 */
const stableToolSegmentKey = (events: readonly EventRecord[]): string => {
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
  const { messages, maxItems } = opts

  const displayMessages = useMemo(
    () => filterMessagesForUiDisplay(messages),
    [messages],
  )

  const responseTargetByAssistantId = useMemo(() => {
    const map = new Map<string, AgentResponseTarget | undefined>()
    for (const message of messages) {
      if (!isAssistantMessage(message)) continue
      const metadata = (
        getMessagePayload(message)?.metadata as
          | { runtime?: { responseTarget?: AgentResponseTarget } }
          | undefined
      )?.runtime
      map.set(message._id, metadata?.responseTarget)
    }
    return map
  }, [messages])

  const askQuestion = useMemo(
    () => deriveAskQuestions(messages, responseTargetByAssistantId),
    [messages, responseTargetByAssistantId],
  )

  const allRows = useMemo<EventRowViewModel[]>(() => {
    const computed: EventRowViewModel[] = []
    /**
     * 1-based per-`userMessageId` count of assistant rows seen so far
     * in this projection walk. Drives `assistantScrollFollowKey(...)`
     * so a live-streaming overlay and the eventual persisted row at
     * the same position end up with the same React key. The display-
     * messages merge upstream filters
     * out overlays whose persisted counterpart has landed, so each
     * `(userMessageId, indexInTurn)` slot is occupied by exactly one
     * source at a time.
     */
    const assistantCountByUserMessageId = new Map<string, number>()

    for (const message of displayMessages) {
      if (isUserMessage(message)) {
        const contextMetadata = getMessagePayload(message)?.metadata?.context
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
          id: message._id,
          text: getDisplayUserText(message),
          ...(windowLabel ? { windowLabel } : {}),
          ...(windowPreviewImageUrl ? { windowPreviewImageUrl } : {}),
          ...(appSelectionLabel ? { appSelectionLabel } : {}),
          attachments: getAttachments(message),
          ...(getChannelEnvelope(message)
            ? { channelEnvelope: getChannelEnvelope(message) }
            : {}),
        }
        computed.push(row)
        const standaloneAskQuestion = askQuestion.standaloneByUserId.get(message._id)
        if (standaloneAskQuestion) {
          const stableKey = `ask-question-for-${message._id}`
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

      if (isAssistantMessage(message)) {
        const text = getDisplayMessageText(message)
        const payload = getMessagePayload(message)
        const replyToUserMessageId =
          typeof payload?.userMessageId === 'string' &&
          payload.userMessageId.length > 0
            ? payload.userMessageId
            : undefined
        const responseTarget = responseTargetByAssistantId.get(message._id)
        const runtimeMetadata = (
          payload?.metadata as
            | { runtime?: { isStreaming?: boolean } }
            | undefined
        )?.runtime
        // Unified key for both live-streaming overlays (synthetic
        // `_id`s) and the eventual persisted rows for the same
        // `(userMessageId, indexInTurn)` slot. The display merge
        // ensures only one source is present at a time, so the count
        // stays consistent.
        let stableKey: string
        if (replyToUserMessageId !== undefined) {
          const indexWithinTurn =
            (assistantCountByUserMessageId.get(replyToUserMessageId) ?? 0) + 1
          assistantCountByUserMessageId.set(
            replyToUserMessageId,
            indexWithinTurn,
          )
          stableKey = assistantScrollFollowKey(
            replyToUserMessageId,
            indexWithinTurn,
          )
        } else {
          stableKey = message._id
        }
        const toolEvents = message.toolEvents
        const resourcePayload = deriveTurnResource(
          toolEvents,
          text,
          getCwd(toolEvents),
          { developerResourcesEnabled: developerResourcePreviewsEnabled },
        )
        const inlineImagePayloads = deriveTurnInlineImagePayloads(toolEvents)
        const sourceDiffPayloads = collectTurnSourceDiffPayloads(toolEvents, {
          developerResourcesEnabled: developerResourcePreviewsEnabled,
        })
        const askQuestionState = askQuestion.payloadByAssistantId.get(message._id)
        const selfModApplied = payload?.selfModApplied
        const isStreamingOverlay =
          message._id.startsWith(STREAMING_OVERLAY_ID_PREFIX) &&
          runtimeMetadata?.isStreaming !== false
        const row: AssistantRowViewModel = {
          kind: 'assistant',
          id: stableKey,
          text,
          cacheKey: stableKey,
          ...(isStreamingOverlay ? { isStreaming: true } : {}),
          ...(responseTarget ? { responseTarget } : {}),
          ...(replyToUserMessageId ? { replyToUserMessageId } : {}),
          ...(getOfficePreviewRef(toolEvents)
            ? { officePreviewRef: getOfficePreviewRef(toolEvents) }
            : {}),
          ...(resourcePayload ? { resourcePayload } : {}),
          ...(inlineImagePayloads.length > 0
            ? { inlineImagePayloads }
            : {}),
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

    // Trailing artifact card: if the latest message in the loaded window
    // is a `user_message` carrying inline-image tool events (fire-and-
    // forget image submission with no assistant reply yet), surface them
    // as a synthetic assistant row right under the user message. Matches
    // the prior `segmentToolEventsByAssistant`-`trailing` behavior under
    // the new "each message owns the tools that follow it" shape.
    const lastDisplayMessage = displayMessages[displayMessages.length - 1]
    if (lastDisplayMessage && isUserMessage(lastDisplayMessage)) {
      const trailingTools = lastDisplayMessage.toolEvents
      const trailingInlineImagePayloads =
        deriveTurnInlineImagePayloads(trailingTools)
      if (trailingInlineImagePayloads.length > 0) {
        const stableKey = `assistant-tool-resource-${stableToolSegmentKey(
          trailingTools,
        )}`
        computed.push({
          kind: 'assistant',
          id: stableKey,
          text: '',
          cacheKey: stableKey,
          replyToUserMessageId: lastDisplayMessage._id,
          inlineImagePayloads: trailingInlineImagePayloads,
        })
      }
    }

    return coalesceInlineImageRows(computed)
  }, [
    askQuestion,
    developerResourcePreviewsEnabled,
    displayMessages,
    responseTargetByAssistantId,
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

  return {
    rows: slicedRows,
    pendingAskQuestion: askQuestion.pendingWithoutAnchor,
  }
}
