/**
 * Renderer-lifetime playback state for message entrance animations.
 *
 * A queued message keeps its id when it drains into the canonical user row.
 * Record that first visible entrance here so the queued-to-sent handoff does
 * not animate the same message a second time.
 */
const queuedMessageEnterPlayedIds = new Set<string>();

export const markQueuedMessageEntryPlayed = (messageId: string): void => {
  queuedMessageEnterPlayedIds.add(messageId);
};

export const hasQueuedMessageEntryPlayed = (messageId: string): boolean =>
  queuedMessageEnterPlayedIds.has(messageId);
