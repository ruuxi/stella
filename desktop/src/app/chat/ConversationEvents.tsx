/**
 * Home full-chat surface.
 *
 * Projects local `EventRecord[]` into row view models via `useEventRows`
 * and mounts the shared `<ChatTimeline>`. Renders the Google Workspace
 * connect card outside the timeline because it's a local-chat-only
 * affordance — other surfaces (Store thread, sidebar) reuse the timeline
 * without dragging in this dependency.
 */
import { memo, useCallback, useSyncExternalStore } from "react";
import type {
  Attachment,
  EventRecord,
} from "@/app/chat/lib/event-transforms";
import { GoogleWorkspaceConnectCard } from "@/app/chat/GoogleWorkspaceConnectCard";
import { GrowIn } from "@/app/chat/GrowIn";
import { useEventRows } from "./use-event-rows";
import { ChatTimeline } from "./ChatTimeline";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import type { QueuedUserMessage } from "./hooks/use-streaming-chat";
import {
  acknowledgeGoogleWorkspaceAuthRequired,
  getGoogleWorkspaceAuthRequired,
  subscribeGoogleWorkspaceAuthRequired,
} from "@/global/integrations/google-workspace-auth-state";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  optimisticUserMessageIds?: string[];
  selfModMap?: Record<string, SelfModAppliedData>;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  onOpenAttachment?: (attachment: Attachment) => void;
  /**
   * Inline working-indicator inputs. Forwarded to `ChatTimeline` which
   * keeps the indicator mounted as the next sibling after the latest
   * assistant row in the tail. The indicator handles its own hold +
   * grow-out exit when `active` flips false, so this prop is always
   * defined.
   */
  indicator?: InlineWorkingIndicatorMountProps;
};

export const ConversationEvents = memo(function ConversationEvents({
  events,
  maxItems,
  streamingText,
  isStreaming,
  pendingUserMessageId,
  queuedUserMessages,
  optimisticUserMessageIds,
  selfModMap,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  onOpenAttachment,
  indicator,
}: Props) {
  const showGwsConnect = useSyncExternalStore(
    subscribeGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
  );

  const handleGwsConnected = useCallback(() => {
    acknowledgeGoogleWorkspaceAuthRequired();
  }, []);

  const { rows: projectedRows, lastUserRowIndex, pendingAskQuestion } = useEventRows({
    events,
    maxItems,
    isStreaming,
    pendingUserMessageId,
    streamingText,
    selfModMap,
  });

  const justSentIds =
    optimisticUserMessageIds && optimisticUserMessageIds.length > 0
      ? new Set(optimisticUserMessageIds)
      : null;
  const rows =
    pendingUserMessageId || justSentIds
      ? projectedRows.map((row) =>
          row.kind === "user" &&
          (row.id === pendingUserMessageId ||
            (justSentIds ? justSentIds.has(row.id) : false))
            ? { ...row, justSent: true }
            : row,
        )
      : projectedRows;

  return (
    <ChatTimeline
      rows={rows}
      lastUserRowIndex={lastUserRowIndex}
      pendingAskQuestion={pendingAskQuestion}
      hasOlderEvents={hasOlderEvents}
      isLoadingOlder={isLoadingOlder}
      isLoadingHistory={isLoadingHistory}
      onOpenAttachment={onOpenAttachment}
      indicator={indicator}
      queuedUserMessages={queuedUserMessages}
      extraTail={
        <GrowIn animate={true} show={showGwsConnect}>
          <GoogleWorkspaceConnectCard onConnected={handleGwsConnected} />
        </GrowIn>
      }
    />
  );
});
