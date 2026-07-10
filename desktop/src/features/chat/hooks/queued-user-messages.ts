import type { ChatContext } from '../../../../../runtime/contracts/index.js'
import type { MessageMetadata } from '../../../../../runtime/contracts/local-chat.js'

export type QueuedUserMessage = {
  id: string
  text: string
  timestamp: number
  /** Monotonic renderer send order captured before any asynchronous work. */
  queueOrder: number
}

/**
 * Structural subset of a queued send payload that the drain combiner
 * understands. Extra fields (deviceId, platform, optimistic event, …) ride
 * along untouched via the generic parameter — the combined payload always
 * inherits them from the FIRST queued message so the turn keeps its
 * original identity/ordering.
 */
export type CombinableQueuedSendPayload = {
  id: string
  queueOrder: number
  userPrompt: string
  selectedText: string | null
  chatContext: ChatContext | null
  messageMetadata?: MessageMetadata
  attachments: unknown[]
}

export const orderQueuedMessages = <
  T extends Pick<CombinableQueuedSendPayload, 'id' | 'queueOrder'>,
>(messages: readonly T[]): T[] =>
  messages
    .map((message, insertionIndex) => ({ message, insertionIndex }))
    .sort(
      (left, right) =>
        left.message.queueOrder - right.message.queueOrder
        || left.insertionIndex - right.insertionIndex,
    )
    .map(({ message }) => message)

/**
 * Restores a drain batch after `startChat` failed before acceptance. Existing
 * ids win so a late failure callback cannot duplicate a message that was
 * already re-queued through another path.
 */
export const restoreQueuedMessagesAfterFailedDrain = <
  T extends Pick<CombinableQueuedSendPayload, 'id' | 'queueOrder'>,
>(current: readonly T[], drained: readonly T[]): T[] => {
  const byId = new Map<string, T>()
  for (const message of drained) byId.set(message.id, message)
  for (const message of current) byId.set(message.id, message)
  return orderQueuedMessages([...byId.values()])
}

const definedEntries = (value: object) =>
  Object.entries(value).filter(([, entry]) => entry !== undefined)

/**
 * Field-wise merge of the chat contexts captured with each queued message.
 * Scalars (window, screenshot, selection, …) take the value from the most
 * recent message that explicitly set them; additive user content
 * (pastedTexts, regionScreenshots, files) is concatenated in queue order so
 * nothing the user attached gets dropped from the combined turn.
 */
const mergeChatContexts = (contexts: ChatContext[]): ChatContext => {
  const merged: Record<string, unknown> = {}
  const pastedTexts: string[] = []
  const regionScreenshots: NonNullable<ChatContext['regionScreenshots']> = []
  const files: NonNullable<ChatContext['files']> = []
  for (const context of contexts) {
    for (const [key, value] of definedEntries(context)) {
      merged[key] = value
    }
    if (context.pastedTexts?.length) pastedTexts.push(...context.pastedTexts)
    if (context.regionScreenshots?.length) {
      regionScreenshots.push(...context.regionScreenshots)
    }
    if (context.files?.length) files.push(...context.files)
  }
  if (pastedTexts.length > 0) merged.pastedTexts = pastedTexts
  if (regionScreenshots.length > 0) merged.regionScreenshots = regionScreenshots
  if (files.length > 0) merged.files = files
  return merged as ChatContext
}

const mergeMessageMetadata = (
  metadatas: MessageMetadata[],
): MessageMetadata | undefined => {
  if (metadatas.length === 0) return undefined
  const merged: Record<string, unknown> = {}
  const context: Record<string, unknown> = {}
  const pastedTexts: NonNullable<
    NonNullable<MessageMetadata['context']>['pastedTexts']
  > = []
  for (const metadata of metadatas) {
    for (const [key, value] of definedEntries(metadata)) {
      if (key === 'context') continue
      merged[key] = value
    }
    if (!metadata.context) continue
    for (const [key, value] of definedEntries(metadata.context)) {
      if (key === 'pastedTexts') continue
      context[key] = value
    }
    if (metadata.context.pastedTexts?.length) {
      pastedTexts.push(...metadata.context.pastedTexts)
    }
  }
  if (pastedTexts.length > 0) context.pastedTexts = pastedTexts
  if (Object.keys(context).length > 0) merged.context = context
  return merged as MessageMetadata
}

/**
 * Collapses every unsent queued message into a single send payload so one
 * idle drain produces ONE turn instead of a turn per queued message.
 *
 * - A single payload is returned as-is (reference-equal), keeping the
 *   one-queued-message path byte-identical to a direct drain.
 * - Prompts are joined in queue order with a blank line between them.
 * - Attachments are concatenated in queue order.
 * - `selectedText` takes the most recent non-empty selection.
 * - Chat context / metadata merge field-wise (latest explicit value wins,
 *   pasted-text collections concatenate).
 * - Identity fields (id, conversation, device, optimistic event, …) come
 *   from the first payload so the combined turn keeps the head message's
 *   transcript slot and run correlation id.
 */
export const combineQueuedSendPayloads = <
  T extends CombinableQueuedSendPayload,
>(
  payloads: readonly T[],
): T | null => {
  if (payloads.length === 0) return null
  const ordered = orderQueuedMessages(payloads)
  const first = ordered[0]
  if (payloads.length === 1) return first

  const prompts = ordered
    .map((payload) => payload.userPrompt.trim())
    .filter((prompt) => prompt.length > 0)
  const selectedText =
    [...ordered]
      .reverse()
      .find(
        (payload) =>
          typeof payload.selectedText === 'string'
          && payload.selectedText.trim().length > 0,
      )?.selectedText ?? null
  const chatContexts = ordered
    .map((payload) => payload.chatContext)
    .filter((context): context is ChatContext => context != null)
  const mergedMetadata = mergeMessageMetadata(
    ordered
      .map((payload) => payload.messageMetadata)
      .filter((metadata): metadata is MessageMetadata => metadata != null),
  )

  const combined: CombinableQueuedSendPayload = {
    ...(first as CombinableQueuedSendPayload),
    userPrompt: prompts.join('\n\n'),
    selectedText,
    chatContext: chatContexts.length > 0 ? mergeChatContexts(chatContexts) : null,
    attachments: ordered.flatMap((payload) => payload.attachments),
  }
  if (mergedMetadata) {
    combined.messageMetadata = mergedMetadata
  } else {
    delete combined.messageMetadata
  }
  return combined as T
}

export const removeQueuedUserMessageById = (
  messages: QueuedUserMessage[],
  messageId: string,
) => messages.filter((message) => message.id !== messageId)

/**
 * Resolves the composer text after a queued message is cancelled and its
 * text restored. When the composer is empty we drop the restored text in
 * wholesale so the user can immediately edit/resend it. When the composer
 * already holds an unsent draft we don't clobber it — the restored text is
 * appended below the draft (separated by a blank line) so nothing the user
 * was typing is lost.
 */
export const restoreQueuedTextToComposer = (
  currentComposerText: string,
  restoredText: string,
) => {
  const restored = restoredText.trim()
  if (restored.length === 0) return currentComposerText
  if (currentComposerText.trim().length === 0) return restored
  return `${currentComposerText.replace(/\s+$/, '')}\n\n${restored}`
}
