import { memo } from "react";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { Attachment, TaskItem } from "@/app/chat/lib/event-transforms";
import {
  TurnItem,
  StreamingIndicator,
  type TurnViewModel,
} from "./MessageTurn";
import { TaskIndicator } from "@/app/chat/TaskIndicator";
import { GrowIn } from "@/app/chat/GrowIn";
import { useTurnViewModels } from "./use-turn-view-models";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  onOpenAttachment?: (attachment: Attachment) => void;
};

function MessageList({
  turns,
  showStreaming,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  runningTasks,
  runningTool,
  onOpenAttachment,
  showStandaloneStreaming,
}: {
  turns: TurnViewModel[];
  showStreaming: boolean;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  runningTasks: TaskItem[];
  runningTool?: string;
  onOpenAttachment?: (attachment: Attachment) => void;
  showStandaloneStreaming: boolean;
}) {
  return (
    <>
      {turns.map((turn) => {
        const shouldAttachStreaming =
          showStreaming &&
          Boolean(pendingUserMessageId) &&
          turn.id === pendingUserMessageId;

        return (
          <TurnItem
            key={turn.id}
            turn={turn}
            onOpenAttachment={onOpenAttachment}
            streaming={
              shouldAttachStreaming
                ? {
                    streamingText,
                    reasoningText,
                    isStreaming,
                    pendingUserMessageId,
                    runningTasks,
                    runningTool,
                  }
                : undefined
            }
          />
        );
      })}

      {showStandaloneStreaming && (
        <StreamingIndicator
          streamingText={streamingText}
          reasoningText={reasoningText}
          isStreaming={isStreaming}
          pendingUserMessageId={pendingUserMessageId}
          runningTasks={runningTasks}
          runningTool={runningTool}
        />
      )}
    </>
  );
}

export const ConversationEvents = memo(function ConversationEvents({
  events,
  maxItems,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  selfModMap,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  onOpenAttachment,
}: Props) {
  const {
    turns,
    showStreaming,
    showStandaloneStreaming,
    processedStreamingText,
    processedReasoningText,
    runningTool,
    runningTasks,
  } = useTurnViewModels({
    events,
    maxItems,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    selfModMap,
  });

  if (isLoadingHistory && turns.length === 0 && !showStreaming) {
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

  if (turns.length === 0 && !showStreaming) {
    return (
      <div className="event-list" data-empty="true">
        <div className="event-empty">Start a conversation</div>
      </div>
    );
  }

  return (
    <div className="event-list">
      {isLoadingOlder && hasOlderEvents && (
        <div className="event-history-status" role="status" aria-live="polite">
          Loading earlier messages...
        </div>
      )}

      <MessageList
        turns={turns}
        showStreaming={showStreaming}
        showStandaloneStreaming={showStandaloneStreaming}
        streamingText={processedStreamingText}
        reasoningText={processedReasoningText}
        isStreaming={isStreaming}
        pendingUserMessageId={pendingUserMessageId}
        runningTasks={runningTasks}
        runningTool={runningTool}
        onOpenAttachment={onOpenAttachment}
      />

      {/* Persistent task progress â€” visible even when orchestrator is not streaming */}
      {!showStreaming && (
        <GrowIn animate={true} show={runningTasks.length > 0}>
          <TaskIndicator tasks={runningTasks} />
        </GrowIn>
      )}
    </div>
  );
});


