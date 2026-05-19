/**
 * Imperative assistant-row scroll-follow signals.
 *
 * Streaming lifecycle (`useLocalAgentStream`) calls `begin` / `end` /
 * `clear` with stable keys (`assistantScrollFollowKey`) that match
 * `data-scroll-follow-key` on assistant rows. Each
 * `useChatScrollManagement` instance subscribes and follows the keyed
 * row via ResizeObserver — no `.event-row--streaming` heuristics.
 */
import { assistantScrollFollowKey } from '@/app/chat/streaming/streaming-types'

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

export const subscribeAssistantScrollFollow = (
  subscriber: ScrollFollowSubscriber,
): (() => void) => {
  subscribers.add(subscriber)
  return () => {
    subscribers.delete(subscriber)
  }
}
