import type {
  AssistantRowViewModel,
  EventRowViewModel,
} from "@/features/chat/conversation-row-types";

/**
 * Whether an assistant row paints ANYTHING on screen.
 *
 * Single source of truth shared by:
 *  - `AssistantMessageRow` — a row with no visible content renders `null`
 *    (or a bare streaming placeholder while the first token is pending);
 *  - `ChatTimeline` — rows that render nothing are dropped BEFORE the
 *    virtualized list is built, so they can't occupy an item slot or
 *    accumulate per-row separator gaps as invisible spacers between
 *    turns. (Empty assistant segments are routine: tool-only stream
 *    segments, and rows whose lifecycle events were re-anchored onto a
 *    different row by `route-lifecycle-events`.)
 *
 * Keep in sync with the render branches in `AssistantMessageRow`: every
 * field that can paint content must be checked here, otherwise a row
 * carrying only that field would be dropped from the timeline.
 */
export const assistantRowHasVisibleContent = (
  row: AssistantRowViewModel,
): boolean =>
  row.text.trim().length > 0 ||
  Boolean(row.officePreviewRef) ||
  Boolean(row.resourcePayload) ||
  (row.inlineImagePayloads?.length ?? 0) > 0 ||
  (row.webSearchResults?.length ?? 0) > 0 ||
  (row.mapArtifacts?.length ?? 0) > 0 ||
  (row.sourceDiffPayloads?.length ?? 0) > 0 ||
  Boolean(row.selfModApplied) ||
  Boolean(row.customSlot) ||
  (row.scheduleReceipt?.affected.length ?? 0) > 0 ||
  Boolean(row.voiceSession) ||
  (row.backgroundWork?.threadIds.length ?? 0) > 0 ||
  (row.agentCompletion?.sections.length ?? 0) > 0 ||
  (row.toolActivity?.steps.length ?? 0) > 0;

/**
 * Whether a timeline row produces a rendered box at all. User rows always
 * render; assistant rows render when they have visible content, or while
 * streaming pre-first-token (the placeholder that gives scroll-follow its
 * `[data-scroll-follow-key]` target).
 */
export const eventRowRendersContent = (row: EventRowViewModel): boolean =>
  row.kind !== "assistant" ||
  Boolean(row.isStreaming) ||
  assistantRowHasVisibleContent(row);
