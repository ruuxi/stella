/**
 * Presentational chat timeline.
 *
 * Renders a list of pre-built `EventRowViewModel`s using the same
 * `MessageRow` components and tail-region logic as the home full chat.
 *
 * Used by:
 *   - `ConversationEvents` (the home chat surface): wraps `useEventRows`
 *     and pipes its result into `<ChatTimeline>`. No behavior change vs.
 *     the previous monolithic implementation.
 *   - The Store thread's `PublishTab`: projects Convex `store_thread_messages`
 *     into `EventRowViewModel`s and mounts the same timeline. Drafts ride
 *     through `assistantRow.customSlot` so they slot in next to the
 *     existing askQuestion / officePreview / selfMod attachments rather
 *     than introducing a parallel row kind.
 *
 * Keeping this purely presentational means new chat surfaces (sidebar,
 * Together rooms, etc.) don't have to fork the timeline — provide rows,
 * mount the component.
 */
import { memo } from "react";
import {
  AssistantMessageRow,
  PendingAskQuestionRow,
  UserMessageRow,
  type EventRowViewModel,
} from "@/app/chat/MessageRow";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import type { AskQuestionState } from "@/app/chat/AskQuestionBubble";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  /**
   * Index of the latest user row in `rows`. Everything from this index
   * onward is wrapped in the `100cqh` tail region so the active turn
   * fills the viewport when scrolled to the top — same invariant the
   * home chat preserves via `.event-row-region--tail`.
   *
   * Pass `-1` to skip the tail region entirely (useful for
   * agent-only surfaces where there's no "active turn" to anchor on).
   */
  lastUserRowIndex?: number;
  /** Optional pending askQuestion bubble rendered as the final tail row. */
  pendingAskQuestion?: AskQuestionState | null;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  emptyState?: React.ReactNode;
  /**
   * Surface-specific node appended after the rows but inside the
   * `.event-list` flex column so it inherits the gap/padding the home
   * chat established (e.g. the Google Workspace connect card). Stays
   * inside the same scroll container as the conversation.
   */
  extraTail?: React.ReactNode;
  onOpenAttachment?: (attachment: Attachment) => void;
};

const renderRow = (
  row: EventRowViewModel,
  onOpenAttachment?: (attachment: Attachment) => void,
) => {
  if (row.kind === "user") {
    return (
      <UserMessageRow
        key={row.id}
        row={row}
        onOpenAttachment={onOpenAttachment}
      />
    );
  }
  return <AssistantMessageRow key={row.id} row={row} />;
};

export const ChatTimeline = memo(function ChatTimeline({
  rows,
  lastUserRowIndex = -1,
  pendingAskQuestion = null,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  emptyState,
  extraTail,
  onOpenAttachment,
}: ChatTimelineProps) {
  if (isLoadingHistory && rows.length === 0) {
    return (
      <div className="event-list" data-loading-history="true">
        <div className="event-history-status" role="status" aria-live="polite">
          Loading conversation...
        </div>
        <div className="thread-placeholder" aria-hidden="true">
          <div className="thread-line" />
          <div className="thread-line short" />
        </div>
        <div className="thread-placeholder" aria-hidden="true">
          <div className="thread-line short" />
          <div className="thread-line" />
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="event-list" data-empty="true">
        {emptyState ?? <div className="event-empty">Start a conversation</div>}
      </div>
    );
  }

  const tailStart = lastUserRowIndex >= 0 ? lastUserRowIndex : rows.length;
  const olderRows = rows.slice(0, tailStart);
  const tailRows = rows.slice(tailStart);

  return (
    <div className="event-list">
      {isLoadingOlder && hasOlderEvents && (
        <div className="event-history-status" role="status" aria-live="polite">
          Loading earlier messages...
        </div>
      )}

      {olderRows.map((row) => renderRow(row, onOpenAttachment))}

      {(tailRows.length > 0 || pendingAskQuestion) && (
        <div className="event-row-region event-row-region--tail">
          {tailRows.map((row) => renderRow(row, onOpenAttachment))}
          {pendingAskQuestion && (
            <PendingAskQuestionRow payload={pendingAskQuestion} />
          )}
        </div>
      )}

      {extraTail}
    </div>
  );
});
