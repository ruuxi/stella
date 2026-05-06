/**
 * Presentational chat timeline.
 *
 * Renders a list of pre-built `EventRowViewModel`s using the same
 * `MessageRow` components as the home full chat.
 *
 * Used by:
 *   - `ConversationEvents` (the home chat surface): wraps `useEventRows`
 *     and pipes its result into `<ChatTimeline>`. No behavior change vs.
 *     the previous monolithic implementation.
 *   - The Store thread's publish surface: projects local Store messages
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
import {
  InlineWorkingIndicator,
  type InlineWorkingIndicatorMountProps,
} from "./InlineWorkingIndicator";
import { ComposerQueuedMessages } from "./ComposerQueuedMessages";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";

type ChatTimelineProps = {
  rows: EventRowViewModel[];
  /**
   * Index of the latest user row in `rows`. Everything from this index
   * onward is wrapped in a fixed-floor tail region so the assistant
   * reply streams into pre-allocated empty space below the freshly-sent
   * user bubble (avoids a double scroll-jump as content arrives).
   *
   * Pass `-1` to skip the tail region entirely (useful for
   * agent-only surfaces with no "active turn" to anchor on).
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
  /**
   * Inline working indicator inputs. The indicator is always mounted
   * inside the tail region — when there's no active work the parent
   * passes `active: false` and the indicator plays its hold + grow-out
   * exit before unmounting itself. Mounting it unconditionally is
   * what keeps the exit animation from being skipped: if we conditionally
   * rendered it from the parent, React would unmount it the moment
   * upstream work finished and the `EXIT_HOLD_MS` timer would never
   * get to run.
   *
   * Anchor placement:
   *  - If there's a row currently `isAnimating`, the indicator is the
   *    immediate next sibling of that row (Claude pattern — moves down
   *    line-by-line with the streaming bubble).
   *  - Otherwise, the indicator sits at the end of the tail region.
   */
  indicator?: InlineWorkingIndicatorMountProps;
  queuedUserMessages?: QueuedUserMessage[];
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
  indicator,
  queuedUserMessages,
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

  /**
   * Index (within `tailRows`) of the latest assistant row — animating
   * or not. The indicator anchors as the immediate next sibling of
   * that row so each fresh line of streaming text pushes the indicator
   * down line-by-line, and so the indicator keeps the *same* React
   * key (`indicator:<row.id>`) across the active → exit transition
   * (otherwise the parent would unmount it mid-exit and skip the
   * grow-out animation). If there's no assistant row in the tail yet
   * (the user just sent a message and we're waiting on the first
   * token), the indicator anchors at the end of the tail region.
   */
  let lastAssistantTailIndex = -1;
  let lastAssistantTailRow: EventRowViewModel | null = null;
  for (let i = tailRows.length - 1; i >= 0; i -= 1) {
    if (tailRows[i].kind === "assistant") {
      lastAssistantTailIndex = i;
      lastAssistantTailRow = tailRows[i];
      break;
    }
  }
  const indicatorKey = lastAssistantTailRow
    ? `indicator:${lastAssistantTailRow.id}`
    : "indicator-tail";
  const renderQueuedMessages = () => (
    <ComposerQueuedMessages
      key="queued-user-messages"
      messages={queuedUserMessages ?? []}
    />
  );

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
          {tailRows.flatMap((row, index) => {
            const node = renderRow(row, onOpenAttachment);
            if (indicator && index === lastAssistantTailIndex) {
              return [
                node,
                <InlineWorkingIndicator key={indicatorKey} {...indicator} />,
                renderQueuedMessages(),
              ];
            }
            return [node];
          })}
          {pendingAskQuestion && (
            <PendingAskQuestionRow payload={pendingAskQuestion} />
          )}
          {indicator && lastAssistantTailIndex < 0 && (
            <InlineWorkingIndicator key={indicatorKey} {...indicator} />
          )}
          {(!indicator || lastAssistantTailIndex < 0) && renderQueuedMessages()}
        </div>
      )}

      {extraTail}
    </div>
  );
});
