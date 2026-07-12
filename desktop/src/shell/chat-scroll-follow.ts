/**
 * Imperative assistant-row scroll-follow signals.
 *
 * Streaming lifecycle (`useLocalAgentStream`) calls `begin` / `end` /
 * `clear` with stable keys (`assistantScrollFollowKey`) that match
 * `data-scroll-follow-key` on assistant rows. Each
 * `useChatScrollManagement` instance subscribes and follows the keyed
 * row via ResizeObserver — no `.event-row--streaming` heuristics.
 */
import { assistantScrollFollowKey } from '@/features/chat/streaming/streaming-types'

export { assistantScrollFollowKey }

type ScrollFollowSubscriber = () => void

const subscribers = new Set<ScrollFollowSubscriber>()

let activeFollowKey: string | null = null

const notify = () => {
  for (const subscriber of subscribers) {
    subscriber()
  }
}

export const getAssistantScrollFollowKey = (): string | null => activeFollowKey

export const beginAssistantScrollFollow = (key: string): void => {
  if (activeFollowKey === key) return
  activeFollowKey = key
  notify()
}

export const endAssistantScrollFollow = (key?: string): void => {
  if (key !== undefined && activeFollowKey !== key) return
  if (activeFollowKey === null) return
  activeFollowKey = null
  notify()
}

export const clearAssistantScrollFollow = (): void => {
  if (activeFollowKey === null) return
  activeFollowKey = null
  notify()
}

/** Row subtree grew (e.g. inline image loaded) — re-run follow targeting. */
export const notifyAssistantScrollFollowLayoutChange = (): void => {
  if (activeFollowKey === null) return
  notify()
}

const growthSubscribers = new Set<ScrollFollowSubscriber>()

/**
 * Inline content outside the streaming text grew — an agent spawn/completion
 * card mounted in a row. Unlike `notifyAssistantScrollFollowLayoutChange`,
 * this fires even with no active follow key: agent completion cards land
 * after the run settled (background agent finished while the chat is idle),
 * and the viewport should still keep them in frame when the user is parked
 * at the bottom. Subscribers decide how (streaming rows keep the keyed
 * follow; idle surfaces settle toward the new end).
 */
export const notifyChatContentGrowth = (): void => {
  for (const subscriber of growthSubscribers) {
    subscriber()
  }
}

export const subscribeChatContentGrowth = (
  subscriber: ScrollFollowSubscriber,
): (() => void) => {
  growthSubscribers.add(subscriber)
  return () => {
    growthSubscribers.delete(subscriber)
  }
}

export const subscribeAssistantScrollFollow = (
  subscriber: ScrollFollowSubscriber,
): (() => void) => {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}
