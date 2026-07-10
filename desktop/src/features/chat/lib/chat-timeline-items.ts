import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";
import { eventRowRendersContent } from "@/features/chat/lib/assistant-row-content";

export type ChatTimelineItem =
  | {
      id: string;
      type: "message";
      row: EventRowViewModel;
    }
  | {
      id: "chat-timeline:working-indicator";
      type: "working-indicator";
    }
  | {
      id: string;
      type: "queued-user";
      message: QueuedUserMessage;
    };

/**
 * Builds the actual virtualized sequence at the active edge of the chat.
 * Queued sends must be list data, not a ListFooter: Legend can retain a
 * footer's old measured position while a streaming row grows or a new
 * post-tool assistant segment is inserted, briefly painting that footer
 * above the active row. Keeping the queue in `data` gives every queued send
 * a stable key and an explicit order after every segment of the active turn.
 */
export const buildChatTimelineItems = (args: {
  rows: EventRowViewModel[];
  queuedUserMessages: readonly QueuedUserMessage[];
  includeWorkingIndicator: boolean;
}): ChatTimelineItem[] => {
  const items: ChatTimelineItem[] = [];
  const messageIds = new Set<string>();

  for (const row of args.rows) {
    if (!eventRowRendersContent(row)) continue;
    messageIds.add(row.id);
    items.push({ id: row.id, type: "message", row });
  }

  if (args.includeWorkingIndicator) {
    items.push({
      id: "chat-timeline:working-indicator",
      type: "working-indicator",
    });
  }

  const queued = args.queuedUserMessages
    .map((message, insertionIndex) => ({ message, insertionIndex }))
    .sort(
      (left, right) =>
        left.message.queueOrder - right.message.queueOrder ||
        left.insertionIndex - right.insertionIndex,
    );
  for (const { message } of queued) {
    // Persistence and queue cleanup can land in separate React updates. The
    // canonical/optimistic row wins that overlap frame, preserving one item
    // with the same id instead of rendering queued + sent twins.
    if (messageIds.has(message.id)) continue;
    items.push({ id: message.id, type: "queued-user", message });
  }

  return items;
};
