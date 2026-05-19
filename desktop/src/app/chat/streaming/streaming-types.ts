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
 * inserted into `displayMessages` by `useConversationDisplayMessages`
 * and dropped the moment a persisted row at the same
 * `(userMessageId, indexInTurn)` slot lands via `chat:localUpdated`.
 *
 * Layout invariants:
 *   - `indexInTurn` is 1-based per `userMessageId`. The first assistant
 *     message in a turn (e.g. the preamble) gets `1`; the post-tool
 *     answer gets `2`; etc.
 *   - `timestamp` need only sort the overlay AFTER its anchoring user
 *     message and after any earlier persisted assistants in the same
 *     turn. `Date.now()` at creation time satisfies that — once the
 *     real persisted row lands, the overlay is dropped before its
 *     timestamp matters for sort stability.
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
  /**
   * Marked true once this slot's text equals the full upstream-received
   * text for its message (set on `ASSISTANT_MESSAGE` boundary or
   * `RUN_FINISHED`). The smoothing-to-overlay mirror effect skips
   * `locked` slots so a subsequent `streamBuffer.reset()` for the next
   * message can't wipe a finalized slot's text.
   */
  locked?: boolean;
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
