import { memo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { Attachment, TaskItem } from "@/app/chat/lib/event-transforms";
import {
  TurnItem,
  StreamingIndicator,
  type TurnViewModel,
} from "./MessageTurn";
import { TaskIndicator } from "@/app/chat/TaskIndicator";
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
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
};

/** Non-virtualized renderer for small lists or when scrollContainerRef is not provided */
function NonVirtualizedList({
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

/** Virtualized renderer for large lists */
function VirtualizedList({
  turns,
  showStreaming,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  runningTasks,
  runningTool,
  onOpenAttachment,
  scrollContainerRef,
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
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  showStandaloneStreaming: boolean;
}) {
  const measurementCache = useRef<Map<string, number>>(new Map());

  const count = turns.length + (showStandaloneStreaming ? 1 : 0);

  const estimateSize = useCallback(
    (index: number) => {
      const turn = turns[index];
      if (turn) {
        const cached = measurementCache.current.get(turn.id);
        if (cached) return cached;
      }
      return 120;
    },
    [turns],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: 3,
    getItemKey: (index) => {
      if (index < turns.length) return turns[index].id;
      return "streaming";
    },
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      const key = element.getAttribute("data-key");
      if (key && key !== "streaming") {
        measurementCache.current.set(key, height);
      }
      return height;
    },
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      style={{
        height: virtualizer.getTotalSize(),
        width: "100%",
        position: "relative",
      }}
    >
      {virtualItems.map((virtualItem) => {
        const isStreamingItem = virtualItem.index >= turns.length;

        if (isStreamingItem) {
          return (
            <div
              key="streaming"
              data-key="streaming"
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
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
            </div>
          );
        }

        const turn = turns[virtualItem.index];
        const shouldAttachStreaming =
          showStreaming &&
          Boolean(pendingUserMessageId) &&
          turn.id === pendingUserMessageId;

        return (
          <div
            key={turn.id}
            data-key={turn.id}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            <TurnItem
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
          </div>
        );
      })}
    </div>
  );
}

const VIRTUALIZATION_THRESHOLD = 20;

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
  scrollContainerRef,
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

  const shouldVirtualize =
    scrollContainerRef && turns.length >= VIRTUALIZATION_THRESHOLD;

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
      {shouldVirtualize ? (
        <VirtualizedList
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
          scrollContainerRef={scrollContainerRef}
        />
      ) : (
        <NonVirtualizedList
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
      )}

      {/* Persistent task progress — visible even when orchestrator is not streaming */}
      {!showStreaming && runningTasks.length > 0 && (
        <TaskIndicator tasks={runningTasks} />
      )}
    </div>
  );
});


