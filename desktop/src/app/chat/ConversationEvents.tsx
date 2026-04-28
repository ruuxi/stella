import { memo, useCallback, useSyncExternalStore } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import {
  AssistantMessageRow,
  PendingAskQuestionRow,
  StreamingTailRow,
  UserMessageRow,
  type EventRowViewModel,
} from "./MessageRow";
import { GoogleWorkspaceConnectCard } from "@/app/chat/GoogleWorkspaceConnectCard";
import { GrowIn } from "@/app/chat/GrowIn";
import { useEventRows } from "./use-event-rows";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import {
  acknowledgeGoogleWorkspaceAuthRequired,
  getGoogleWorkspaceAuthRequired,
  subscribeGoogleWorkspaceAuthRequired,
} from "@/global/integrations/google-workspace-auth-state";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  /** Reasoning UI was removed; this prop is accepted for back-compat with
   * call sites but no longer rendered. */
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
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

export const ConversationEvents = memo(function ConversationEvents({
  events,
  maxItems,
  streamingText,
  isStreaming,
  pendingUserMessageId,
  selfModMap,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  onOpenAttachment,
}: Props) {
  const showGwsConnect = useSyncExternalStore(
    subscribeGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
    getGoogleWorkspaceAuthRequired,
  );

  const handleGwsConnected = useCallback(() => {
    acknowledgeGoogleWorkspaceAuthRequired();
  }, []);

  const { rows, lastUserRowIndex, pendingAskQuestion, showStreamingTail } =
    useEventRows({
      events,
      maxItems,
      isStreaming,
      pendingUserMessageId,
      selfModMap,
    });

  if (isLoadingHistory && rows.length === 0 && !showStreamingTail) {
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

  if (rows.length === 0 && !showStreamingTail) {
    return (
      <div className="event-list" data-empty="true">
        <div className="event-empty">Start a conversation</div>
      </div>
    );
  }

  /*
   * Tail region wrapper: gives the latest user message + everything after
   * it a `100cqh` reading area, so when `scrollTurnToPinTop` aligns the
   * user bubble to the viewport top there is enough room below for the
   * assistant reply to fill the viewport. Mirrors the old
   * `.session-turn--last-turn` behavior, but moved to a single wrapper
   * around the linear tail rather than a per-turn container.
   */
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

      {(tailRows.length > 0 || showStreamingTail || pendingAskQuestion) && (
        <div className="event-row-region event-row-region--tail">
          {tailRows.map((row) => renderRow(row, onOpenAttachment))}
          {pendingAskQuestion && (
            <PendingAskQuestionRow payload={pendingAskQuestion} />
          )}
          {showStreamingTail && (
            <StreamingTailRow
              streamingText={streamingText}
              isStreaming={isStreaming}
              pendingUserMessageId={pendingUserMessageId}
            />
          )}
        </div>
      )}

      <GrowIn animate={true} show={showGwsConnect}>
        <GoogleWorkspaceConnectCard onConnected={handleGwsConnected} />
      </GrowIn>
    </div>
  );
});
