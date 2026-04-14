import { memo, useMemo, useState, useEffect, useCallback } from "react";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import type { Attachment } from "@/app/chat/lib/event-transforms";
import {
  TurnItem,
  StreamingIndicator,
  type TurnViewModel,
} from "./MessageTurn";
import { GoogleWorkspaceConnectCard } from "@/app/chat/GoogleWorkspaceConnectCard";
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
  liveTasks?: TaskItem[];
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
  onOpenAttachment,
  showStandaloneStreaming,
  liveTasks,
}: {
  turns: TurnViewModel[];
  showStreaming: boolean;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  onOpenAttachment?: (attachment: Attachment) => void;
  showStandaloneStreaming: boolean;
  liveTasks?: TaskItem[];
}) {
  const taskReasoningByTaskId = useMemo(() => {
    if (!liveTasks?.length) return null;
    const map = new Map<string, string>();
    for (const task of liveTasks) {
      if (task.status === "running" && task.reasoningText?.trim()) {
        map.set(task.id, task.reasoningText);
      }
    }
    return map.size > 0 ? map : null;
  }, [liveTasks]);

  return (
    <>
      {turns.map((turn, index) => {
        const shouldAttachStreaming =
          showStreaming &&
          Boolean(pendingUserMessageId) &&
          turn.id === pendingUserMessageId;

        const taskReasoning = turn.taskId && taskReasoningByTaskId
          ? taskReasoningByTaskId.get(turn.taskId)
          : undefined;

        return (
          <TurnItem
            key={turn.id}
            turn={turn}
            isLastTurn={index === turns.length - 1}
            onOpenAttachment={onOpenAttachment}
            taskReasoningText={taskReasoning}
            streaming={
              shouldAttachStreaming
                ? {
                    streamingText,
                    reasoningText,
                    isStreaming,
                    pendingUserMessageId,
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
  liveTasks,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  onOpenAttachment,
}: Props) {
  const [showGwsConnect, setShowGwsConnect] = useState(false);

  useEffect(() => {
    const unsub = window.electronAPI?.googleWorkspace.onAuthRequired(() => {
      setShowGwsConnect(true);
    });
    return () => { unsub?.(); };
  }, []);

  const handleGwsConnected = useCallback(() => {
    setShowGwsConnect(false);
  }, []);

  const {
    turns,
    showStreaming,
    showStandaloneStreaming,
    processedStreamingText,
    processedReasoningText,
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
        onOpenAttachment={onOpenAttachment}
        liveTasks={liveTasks}
      />

      <GrowIn animate={true} show={showGwsConnect}>
        <GoogleWorkspaceConnectCard onConnected={handleGwsConnected} />
      </GrowIn>

    </div>
  );
});

