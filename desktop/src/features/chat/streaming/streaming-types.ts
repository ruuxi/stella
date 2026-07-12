/**
 * Shared types for the streaming engine.
 * Separate file to avoid circular imports between
 * use-streaming-chat.ts and use-resume-agent-run.ts.
 */
export type {
  AgentResponseTarget,
  AgentStreamEvent,
  SelfModAppliedData,
} from "../../../../../runtime/contracts/agent-stream.js";

import type { AgentResponseTarget } from "../../../../../runtime/contracts/agent-stream.js";

/**
 * In-memory assistant message currently being streamed.
 *
 * Stella streams runtime → renderer over IPC and the persisted source
 * of truth is SQLite. Per Option A (standard chat-UI pattern, c.f.
 * Vercel `useChat`), the renderer treats stream chunks as updates to
 * a synthetic in-memory `MessageRecord` rather than overlaying a
 * separate "tail row" on top of the persisted list. The overlay is
 * inserted into `displayMessages` by `useConversationDisplayMessages`.
 * While it exists, it masks the persisted row at the same
 * `(userMessageId, indexInTurn)` slot and borrows that row's metadata.
 *
 * Layout invariants:
 *   - `indexInTurn` is 1-based per `userMessageId`. The first assistant
 *     message in a turn (e.g. the preamble) gets `1`; the post-tool
 *     answer gets `2`; etc.
 *   - `timestamp` need only sort the overlay AFTER its anchoring user
 *     message and after any earlier persisted assistants in the same
 *     turn. `Date.now()` at creation time satisfies that; if the real
 *     persisted row lands while the overlay is still present, the
 *     persisted twin is hidden until the overlay is cleared.
 *   - `responseTarget` mirrors the runtime's per-message target so the
 *     row renderer can pick up agent-terminal-notice styling, etc.
 */
export type StreamingAssistantOverlay = {
  _id: string;
  userMessageId: string;
  indexInTurn: number;
  text: string;
  responseTarget?: AgentResponseTarget;
  timestamp: number;
  runId: string;
  /** Exact persisted twin learned from the assistant-message boundary. */
  canonicalMessageId?: string;
  /**
   * Marked true once this slot's text equals the full upstream-received
   * text for its message (set on `ASSISTANT_MESSAGE` boundary or
   * `RUN_FINISHED`).
   */
  locked?: boolean;
};

export const linkStreamingAssistantCanonicalMessage = (
  overlays: StreamingAssistantOverlay[],
  args: {
    userMessageId: string;
    indexInTurn: number;
    canonicalMessageId: string;
  },
): StreamingAssistantOverlay[] => {
  const index = overlays.findIndex(
    (overlay) =>
      overlay.userMessageId === args.userMessageId
      && overlay.indexInTurn === args.indexInTurn,
  );
  if (index < 0) return overlays;
  const current = overlays[index]!;
  if (current.canonicalMessageId === args.canonicalMessageId) return overlays;
  const next = overlays.slice();
  next[index] = { ...current, canonicalMessageId: args.canonicalMessageId };
  return next;
};

/** Replace optimistic streamed text with the provider's finalized text. */
export const reconcileStreamingAssistantCanonicalMessage = (
  overlays: StreamingAssistantOverlay[],
  args: {
    userMessageId: string;
    indexInTurn: number;
    canonicalMessageId?: string;
    canonicalText: string;
  },
): StreamingAssistantOverlay[] => {
  const index = overlays.findIndex(
    (overlay) =>
      overlay.userMessageId === args.userMessageId &&
      overlay.indexInTurn === args.indexInTurn,
  );
  if (index < 0) return overlays;
  const current = overlays[index]!;
  const canonicalMessageId =
    args.canonicalMessageId ?? current.canonicalMessageId;
  if (
    current.text === args.canonicalText &&
    current.locked &&
    current.canonicalMessageId === canonicalMessageId
  ) {
    return overlays;
  }
  const next = overlays.slice();
  next[index] = {
    ...current,
    text: args.canonicalText,
    locked: true,
    ...(canonicalMessageId ? { canonicalMessageId } : {}),
  };
  return next;
};

/** Stable synthetic id used for both the overlay row and its React key. */
export const streamingAssistantOverlayId = (
  userMessageId: string,
  indexInTurn: number,
): string => `stream-overlay:${userMessageId}:${indexInTurn}`;

/** Stable scroll-follow / React row key for an assistant slot in a turn. */
export const assistantScrollFollowKey = (
  userMessageId: string,
  indexInTurn: number,
): string => `assistant-${userMessageId}-${indexInTurn}`;
