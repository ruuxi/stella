import { useMemo, memo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  EventRecord,
  MessagePayload,
  Attachment,
  MessageTurn,
  TaskItem,
} from "../hooks/use-conversation-events";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "../hooks/use-conversation-events";
import { WorkingIndicator } from "../components/chat/WorkingIndicator";
import { Markdown } from "../components/chat/Markdown";
import { ReasoningSection } from "../components/chat/ReasoningSection";
import { TaskIndicator } from "../components/chat/TaskIndicator";

type Props = {
  events: EventRecord[];
  maxItems?: number;
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  onOpenAttachment?: (attachment: Attachment) => void;
  /** Scroll container ref for virtualization. If not provided, virtualization is disabled. */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
};

type StreamingTurnProps = {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  runningTasks: TaskItem[];
  runningTool?: string;
};

const getEventText = (event: EventRecord): string => {
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as MessagePayload;
    return payload.text ?? payload.content ?? payload.message ?? "";
  }
  return "";
};

const getAttachments = (event: EventRecord): Attachment[] => {
  if (event.payload && typeof event.payload === "object") {
    return (event.payload as MessagePayload).attachments ?? [];
  }
  return [];
};

/** Memoized turn renderer to prevent unnecessary re-renders */
const TurnItem = memo(
  function TurnItem({
    turn,
    onOpenAttachment,
    streaming,
  }: {
    turn: MessageTurn;
    onOpenAttachment?: (attachment: Attachment) => void;
    streaming?: StreamingTurnProps;
  }) {
  const userText = getEventText(turn.userMessage);
  const userAttachments = getAttachments(turn.userMessage);
  const assistantText = turn.assistantMessage
    ? getEventText(turn.assistantMessage)
    : "";
  const hasAssistantContent = assistantText.trim().length > 0;
  const hasUserContent = userText.trim().length > 0 || userAttachments.length > 0;

  const hasStreamingContent = Boolean(streaming?.streamingText?.trim().length);
  const hasReasoningContent = Boolean(streaming?.reasoningText?.trim().length);
  const shouldShowStreamingAssistant = Boolean(
    !hasAssistantContent &&
      Boolean(streaming) &&
      (hasStreamingContent ||
        hasReasoningContent ||
        (streaming?.runningTasks.length ?? 0) > 0 ||
        streaming?.isStreaming),
  );

  const shouldShowAssistantArea = hasAssistantContent || shouldShowStreamingAssistant;
  const assistantDisplayText = hasAssistantContent
    ? assistantText
    : streaming?.streamingText ?? "";
  const assistantCacheKey = `assistant-${turn.id}`;

  return (
    <div className="session-turn">
      {/* User message (skip if empty, e.g., for standalone assistant messages) */}
      {hasUserContent && (
        <div className="event-item user">
          <div className="event-body">{userText}</div>
          {userAttachments.length > 0 && (
            <div className="event-attachments">
              {userAttachments.map((attachment, index) => {
                if (attachment.url) {
                  return (
                    <img
                      key={attachment.id ?? `${index}`}
                      src={attachment.url}
                      alt="Attachment"
                      className="event-attachment"
                      onClick={() => onOpenAttachment?.(attachment)}
                      role={onOpenAttachment ? "button" : undefined}
                      tabIndex={onOpenAttachment ? 0 : undefined}
                      onKeyDown={(eventKey) => {
                        if (
                          onOpenAttachment &&
                          (eventKey.key === "Enter" || eventKey.key === " ")
                        ) {
                          onOpenAttachment(attachment);
                        }
                      }}
                    />
                  );
                }
                return (
                  <div
                    key={attachment.id ?? `${index}`}
                    className="event-attachment-fallback"
                  >
                    Attachment {index + 1}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Assistant / Streaming assistant (keep mounted to avoid flicker on completion) */}
      {shouldShowAssistantArea && (
        <div
          className={`event-item assistant${shouldShowStreamingAssistant ? " streaming" : ""}`}
        >
          {shouldShowStreamingAssistant && streaming && (
            <>
              {streaming.runningTasks.length > 0 && (
                <TaskIndicator tasks={streaming.runningTasks} />
              )}
              {hasReasoningContent && streaming.reasoningText && (
                <ReasoningSection
                  content={streaming.reasoningText}
                  isStreaming={Boolean(streaming.isStreaming && !hasStreamingContent)}
                />
              )}
              {!hasStreamingContent &&
                !hasReasoningContent &&
                streaming.runningTasks.length === 0 && (
                  <WorkingIndicator
                    isResponding={false}
                    isReasoning={true}
                    toolName={streaming.runningTool}
                  />
                )}
            </>
          )}

          {assistantDisplayText.trim().length > 0 && (
            <Markdown text={assistantDisplayText} cacheKey={assistantCacheKey} />
          )}
        </div>
      )}
    </div>
  );
  },
  (prevProps, nextProps) => {
    if (prevProps.onOpenAttachment !== nextProps.onOpenAttachment) {
      return false;
    }

    const prevTurn = prevProps.turn;
    const nextTurn = nextProps.turn;

    if (prevTurn.userMessage._id !== nextTurn.userMessage._id) {
      return false;
    }

    if (getEventText(prevTurn.userMessage) !== getEventText(nextTurn.userMessage)) {
      return false;
    }

    const prevAttachments = getAttachments(prevTurn.userMessage);
    const nextAttachments = getAttachments(nextTurn.userMessage);
    if (prevAttachments.length !== nextAttachments.length) {
      return false;
    }
    for (let i = 0; i < prevAttachments.length; i += 1) {
      const prevAttachment = prevAttachments[i];
      const nextAttachment = nextAttachments[i];
      if ((prevAttachment?.id ?? null) !== (nextAttachment?.id ?? null)) return false;
      if ((prevAttachment?.url ?? null) !== (nextAttachment?.url ?? null)) return false;
      if ((prevAttachment?.mimeType ?? null) !== (nextAttachment?.mimeType ?? null)) return false;
      if ((prevAttachment?.name ?? null) !== (nextAttachment?.name ?? null)) return false;
    }

    if (
      (prevTurn.assistantMessage?._id ?? null) !== (nextTurn.assistantMessage?._id ?? null)
    ) {
      return false;
    }

    const prevAssistantText = prevTurn.assistantMessage
      ? getEventText(prevTurn.assistantMessage)
      : "";
    const nextAssistantText = nextTurn.assistantMessage
      ? getEventText(nextTurn.assistantMessage)
      : "";
    if (prevAssistantText !== nextAssistantText) {
      return false;
    }

    const prevStreaming = prevProps.streaming;
    const nextStreaming = nextProps.streaming;
    if (!prevStreaming && !nextStreaming) {
      return true;
    }
    if (!prevStreaming || !nextStreaming) {
      return false;
    }

    if (prevStreaming.streamingText !== nextStreaming.streamingText) return false;
    if (prevStreaming.reasoningText !== nextStreaming.reasoningText) return false;
    if (prevStreaming.isStreaming !== nextStreaming.isStreaming) return false;
    if (prevStreaming.pendingUserMessageId !== nextStreaming.pendingUserMessageId) return false;
    if (prevStreaming.runningTool !== nextStreaming.runningTool) return false;

    if (prevStreaming.runningTasks.length !== nextStreaming.runningTasks.length) return false;
    for (let i = 0; i < prevStreaming.runningTasks.length; i += 1) {
      const prevTask = prevStreaming.runningTasks[i];
      const nextTask = nextStreaming.runningTasks[i];
      if (prevTask.id !== nextTask.id) return false;
      if (prevTask.status !== nextTask.status) return false;
      if (prevTask.agentType !== nextTask.agentType) return false;
      if (prevTask.description !== nextTask.description) return false;
    }

    return true;
  },
);

/** Streaming indicator component */
const StreamingIndicator = memo(function StreamingIndicator({
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  runningTasks,
  runningTool,
}: {
  streamingText?: string;
  reasoningText?: string;
  isStreaming?: boolean;
  pendingUserMessageId?: string | null;
  runningTasks: TaskItem[];
  runningTool?: string;
}) {
  const hasStreamingContent = Boolean(streamingText && streamingText.trim().length > 0);
  const hasReasoningContent = Boolean(reasoningText && reasoningText.trim().length > 0);

  return (
    <div className="session-turn">
      <div className="event-item assistant streaming">
        {/* Show active tasks when agents are working */}
        {runningTasks.length > 0 && (
          <TaskIndicator tasks={runningTasks} />
        )}
        {/* Show reasoning section when we have reasoning content */}
        {hasReasoningContent && (
          <ReasoningSection
            content={reasoningText!}
            isStreaming={isStreaming && !hasStreamingContent}
          />
        )}
        {/* Show working indicator when no content yet */}
        {!hasStreamingContent && !hasReasoningContent && runningTasks.length === 0 && (
          <WorkingIndicator
            isResponding={false}
            isReasoning={true}
            toolName={runningTool}
          />
        )}
        {hasStreamingContent && streamingText && (
          <Markdown
            text={streamingText}
            cacheKey={pendingUserMessageId ? `streaming-${pendingUserMessageId}` : undefined}
          />
        )}
      </div>
    </div>
  );
});

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
  turns: MessageTurn[];
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

      {/* Streaming indicator */}
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
  turns: MessageTurn[];
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

  // Total count includes turns + streaming indicator (if showing)
  const count = turns.length + (showStandaloneStreaming ? 1 : 0);

  const estimateSize = useCallback((index: number) => {
    // Check cache first
    const turn = turns[index];
    if (turn) {
      const cached = measurementCache.current.get(turn.id);
      if (cached) return cached;
    }
    // Default estimate: ~120px for a typical message turn
    return 120;
  }, [turns]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: 3,
    getItemKey: (index) => {
      if (index < turns.length) {
        return turns[index].id;
      }
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

// Threshold for enabling virtualization (number of turns)
const VIRTUALIZATION_THRESHOLD = 20;

export const ConversationEvents = memo(function ConversationEvents({
  events,
  maxItems,
  streamingText,
  reasoningText,
  isStreaming,
  pendingUserMessageId,
  onOpenAttachment,
  scrollContainerRef,
}: Props) {
  const visible = useMemo(() => {
    return maxItems ? events.slice(-maxItems) : events;
  }, [events, maxItems]);

  // Check if the pending user message already has an assistant reply in events.
  // If so, hide streaming section immediately to prevent duplicate content flash.
  const hasAssistantReply = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return visible.some(
      (event) =>
        event.type === "assistant_message" &&
        (event.payload as { userMessageId?: string } | null)?.userMessageId === pendingUserMessageId
    );
  }, [visible, pendingUserMessageId]);

  const showStreaming = Boolean((isStreaming || streamingText) && !hasAssistantReply);

  // Group events into message turns with their associated tool steps
  const turns = useMemo(() => groupEventsIntoTurns(visible), [visible]);

  // Get running tool for streaming indicator
  const runningTool = getCurrentRunningTool(visible);

  // Get running tasks for task indicator
  const runningTasks = useMemo(() => getRunningTasks(visible), [visible]);

  // Use virtualization only when:
  // 1. scrollContainerRef is provided
  // 2. We have enough items to benefit from virtualization
  const shouldVirtualize = scrollContainerRef && turns.length >= VIRTUALIZATION_THRESHOLD;

  const hasPendingTurn = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return turns.some((turn) => turn.id === pendingUserMessageId);
  }, [turns, pendingUserMessageId]);

  // If the pending turn isn't present (e.g. maxItems sliced it out), fall back to a standalone streaming row.
  const showStandaloneStreaming = Boolean(showStreaming && !hasPendingTurn);

  if (turns.length === 0 && !showStreaming) {
    return (
      <div className="event-list">
        <div className="event-empty">Start a conversation</div>
      </div>
    );
  }

  return (
    <div className="event-list">
      {shouldVirtualize ? (
        <VirtualizedList
          turns={turns}
          showStreaming={showStreaming}
          showStandaloneStreaming={showStandaloneStreaming}
          streamingText={streamingText}
          reasoningText={reasoningText}
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
          streamingText={streamingText}
          reasoningText={reasoningText}
          isStreaming={isStreaming}
          pendingUserMessageId={pendingUserMessageId}
          runningTasks={runningTasks}
          runningTool={runningTool}
          onOpenAttachment={onOpenAttachment}
        />
      )}
    </div>
  );
});
