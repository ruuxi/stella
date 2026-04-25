import { useMemo } from 'react'
import type { EventRecord } from '@/app/chat/lib/event-transforms'
import type { MessagePayload } from '@/app/chat/lib/event-transforms'
import { isOfficePreviewRef } from '@/shared/contracts/office-preview'
import { groupEventsIntoTurns } from '@/app/chat/lib/event-transforms'
import { deriveTurnResource } from '@/app/chat/lib/derive-turn-resource'
import { filterEventsForUiDisplay } from '@/app/chat/lib/message-display'
import { isOrchestratorChatMessagePayload } from '@/app/chat/emotes/message-source'
import {
  type TurnViewModel,
} from './MessageTurn'
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
  type Selection,
  type AskQuestionState,
} from './AskQuestionBubble'

type BaseTurnViewModel = Omit<TurnViewModel, 'selfModApplied'>

const getMessagePayload = (event?: EventRecord): MessagePayload | null => {
  if (!event?.payload || typeof event.payload !== 'object') {
    return null
  }
  return event.payload as MessagePayload
}

const getWebSearchBadgeHtml = (events: EventRecord[]): string | undefined => {
  for (const event of events) {
    if (event.type !== 'tool_result') {
      continue
    }

    const payload = event.payload as
      | {
          toolName?: string
          html?: unknown
          result?: unknown
        }
      | undefined
    if (!payload || typeof payload.toolName !== 'string') {
      continue
    }

    if (payload.toolName.toLowerCase() !== 'web') {
      continue
    }

    if (typeof payload.html === 'string' && payload.html.trim()) {
      return payload.html
    }

    if (typeof payload.result === 'string' && payload.result.trim()) {
      return payload.result
    }
  }

  return undefined
}

const getAskQuestionPayload = (
  events: EventRecord[],
): AskQuestionState | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_request') {
      continue
    }
    const payload = event.payload as
      | { toolName?: string; args?: unknown }
      | undefined
    if (!payload || typeof payload.toolName !== 'string') {
      continue
    }
    if (payload.toolName !== 'askQuestion') {
      continue
    }
    const parsed = parseAskQuestionArgs(payload.args)
    if (parsed) {
      return parsed
    }
  }
  return undefined
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

const isAskQuestionResponseMessage = (event: EventRecord): boolean => {
  if (event.type !== 'user_message') return false
  const payload = getMessagePayload(event)
  return (
    payload?.metadata?.trigger?.kind === 'ask_question_response' &&
    payload.metadata.trigger.source === 'ask-question-bubble'
  )
}

const deriveAnsweredAskQuestions = (
  events: EventRecord[],
): Map<string, Record<number, Selection>> => {
  const answeredByTurnId = new Map<
    string,
    Record<number, Selection>
  >()
  let currentVisibleTurnId: string | null = null
  let pendingAsk:
    | { turnId: string; payload: AskQuestionState }
    | null = null

  for (const event of events) {
    if (event.type === 'user_message') {
      if (isAskQuestionResponseMessage(event) && pendingAsk) {
        const text =
          typeof event.payload?.text === 'string' ? event.payload.text : ''
        const selections = parseAskQuestionAnswersMessage(
          pendingAsk.payload,
          text,
        )
        if (selections) {
          answeredByTurnId.set(pendingAsk.turnId, selections)
          pendingAsk = null
        }
        continue
      }
      if (getMessagePayload(event)?.metadata?.ui?.visibility === 'hidden') {
        continue
      }
      currentVisibleTurnId = event._id
      continue
    }

    if (!currentVisibleTurnId || event.type !== 'tool_request') {
      continue
    }

    const payload = event.payload as
      | { toolName?: string; args?: unknown }
      | undefined
    if (payload?.toolName !== 'askQuestion') {
      continue
    }
    const parsed = parseAskQuestionArgs(payload.args)
    if (parsed) {
      pendingAsk = { turnId: currentVisibleTurnId, payload: parsed }
    }
  }

  return answeredByTurnId
}

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined

const getTurnCwd = (events: EventRecord[]): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_request') {
      continue
    }
    const payload = event.payload as { args?: unknown } | undefined
    if (!payload?.args || typeof payload.args !== 'object') {
      continue
    }
    const args = payload.args as Record<string, unknown>
    const cwd =
      asNonEmptyString(args.working_directory) ??
      asNonEmptyString(args.workdir) ??
      asNonEmptyString(args.cwd)
    if (cwd) {
      return cwd
    }
  }
  return undefined
}

const getOfficePreviewRef = (events: EventRecord[]) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'tool_result') {
      continue
    }

    const payload = event.payload as { officePreviewRef?: unknown } | undefined
    if (isOfficePreviewRef(payload?.officePreviewRef)) {
      return payload.officePreviewRef
    }
  }

  return undefined
}

export function useTurnViewModels(opts: {
  events: EventRecord[]
  maxItems?: number
  streamingText?: string
  reasoningText?: string
  isStreaming?: boolean
  pendingUserMessageId?: string | null
  streamingResponseTarget?: AgentResponseTarget | null
  selfModMap?: Record<string, SelfModAppliedData>
}) {
  const {
    events,
    maxItems,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    streamingResponseTarget,
    selfModMap,
  } = opts

  // Check if the pending user message already has an assistant reply
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

  const showStreaming = Boolean(
    !hasAssistantReply && (isStreaming || streamingText),
  )

  const maxTurns =
    typeof maxItems === 'number' ? Math.max(0, Math.floor(maxItems)) : null

  const displayEvents = useMemo(
    () => filterEventsForUiDisplay(events),
    [events],
  )
  const answeredAskQuestions = useMemo(
    () => deriveAnsweredAskQuestions(events),
    [events],
  )
  const allTurns = useMemo(
    () => groupEventsIntoTurns(displayEvents),
    [displayEvents],
  )
  const slicedTurns = useMemo(() => {
    if (maxTurns === null) return allTurns
    if (maxTurns <= 0) return []

    const baseStart = Math.max(0, allTurns.length - maxTurns)
    if (!showStreaming || !pendingUserMessageId) {
      return allTurns.slice(baseStart)
    }

    const pendingIndex = allTurns.findIndex(
      (turn) => turn.id === pendingUserMessageId,
    )

    if (pendingIndex !== -1 && pendingIndex < baseStart) {
      const windowEnd = pendingIndex + 1
      const windowStart = Math.max(0, windowEnd - maxTurns)
      return allTurns.slice(windowStart, windowEnd)
    }

    return allTurns.slice(baseStart)
  }, [allTurns, maxTurns, pendingUserMessageId, showStreaming])

  const baseTurns = useMemo(() => {
    return slicedTurns.map((turn): BaseTurnViewModel => {
      const userText = getDisplayUserText(turn.userMessage)
      const contextMetadata = getMessagePayload(turn.userMessage)?.metadata
        ?.context
      const userWindowLabel = contextMetadata?.windowLabel
      const userWindowPreviewImageUrl = contextMetadata?.windowPreviewImageUrl
      const userAttachments = getAttachments(turn.userMessage)
      const userChannelEnvelope = getChannelEnvelope(turn.userMessage)
      const assistantText = turn.assistantMessage
        ? getDisplayMessageText(turn.assistantMessage)
        : ''
      const assistantMessageId = turn.assistantMessage?._id ?? null
      const assistantMetadata = getMessagePayload(turn.assistantMessage)
        ?.metadata as
        | { runtime?: { responseTarget?: AgentResponseTarget } }
        | undefined
      const assistantResponseTarget =
        assistantMetadata?.runtime?.responseTarget
      const assistantEmotesEnabled = isOrchestratorChatMessagePayload(
        getMessagePayload(turn.assistantMessage),
      )
      const askQuestionPayload = getAskQuestionPayload(turn.toolEvents)
      const askQuestionSelections = answeredAskQuestions.get(turn.id)
      const askQuestionTargetAgentId =
        getAskQuestionTargetAgentId(assistantResponseTarget)
      const resourcePayload = deriveTurnResource(
        turn.toolEvents,
        assistantText,
        getTurnCwd(turn.toolEvents),
      )

      return {
        id: turn.id,
        userText,
        ...(typeof userWindowLabel === 'string' && userWindowLabel.trim()
          ? { userWindowLabel: userWindowLabel.trim() }
          : {}),
        ...(typeof userWindowPreviewImageUrl === 'string' &&
        userWindowPreviewImageUrl.trim()
          ? { userWindowPreviewImageUrl: userWindowPreviewImageUrl.trim() }
          : {}),
        userAttachments,
        userChannelEnvelope,
        assistantText,
        assistantMessageId,
        ...(assistantResponseTarget ? { assistantResponseTarget } : {}),
        assistantEmotesEnabled,
        webSearchBadgeHtml: getWebSearchBadgeHtml(turn.toolEvents),
        officePreviewRef: getOfficePreviewRef(turn.toolEvents),
        ...(resourcePayload ? { resourcePayload } : {}),
        ...(askQuestionPayload
          ? {
              askQuestion: {
                ...askQuestionPayload,
                ...(askQuestionTargetAgentId
                  ? { targetAgentId: askQuestionTargetAgentId }
                  : {}),
                ...(askQuestionSelections
                  ? {
                      submitted: true,
                      selections: askQuestionSelections,
                    }
                  : {}),
              },
            }
          : {}),
      }
    })
  }, [answeredAskQuestions, slicedTurns])

  const turns = useMemo(() => {
    if (!selfModMap) {
      return baseTurns
    }

    let hasAppliedSelfMod = false
    const nextTurns = baseTurns.map((turn): TurnViewModel => {
      const selfModApplied = selfModMap[turn.id]
      if (!selfModApplied) {
        return turn
      }
      hasAppliedSelfMod = true
      return { ...turn, selfModApplied }
    })

    return hasAppliedSelfMod ? nextTurns : baseTurns
  }, [baseTurns, selfModMap])

  const streamingTargetTurnId = useMemo(() => {
    if (
      streamingResponseTarget?.type !== 'agent_turn' &&
      streamingResponseTarget?.type !== 'agent_terminal_notice'
    ) {
      return pendingUserMessageId ?? null
    }

    const targetAgentId = streamingResponseTarget.agentId
    for (const turn of turns) {
      const responseTarget = turn.assistantResponseTarget
      if (
        responseTarget &&
        (responseTarget.type === 'agent_turn' ||
          responseTarget.type === 'agent_terminal_notice') &&
        responseTarget.agentId === targetAgentId
      ) {
        return turn.id
      }
    }

    return pendingUserMessageId ?? null
  }, [pendingUserMessageId, streamingResponseTarget, turns])

  const processedStreamingText = streamingText
  const processedReasoningText = reasoningText

  const hasPendingTurn = useMemo(
    () =>
      Boolean(
        streamingTargetTurnId &&
          turns.some((turn) => turn.id === streamingTargetTurnId),
      ),
    [turns, streamingTargetTurnId],
  )

  const showStandaloneStreaming = Boolean(
    showStreaming && streamingTargetTurnId && !hasPendingTurn,
  )

  return {
    turns,
    showStreaming,
    showStandaloneStreaming,
    processedStreamingText,
    processedReasoningText,
    streamingTargetTurnId,
    isReplacingAssistant:
      Boolean(streamingTargetTurnId) &&
      streamingTargetTurnId !== pendingUserMessageId,
  }
}
