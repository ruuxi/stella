import { useMemo, memo, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  EventRecord,
  MessagePayload,
  Attachment,
  TaskItem,
} from "../hooks/use-conversation-events";
import {
  groupEventsIntoTurns,
  getCurrentRunningTool,
  getRunningTasks,
} from "../hooks/use-conversation-events";
import { useDepseudonymize } from "../hooks/use-depseudonymize";
import { WorkingIndicator } from "../components/chat/WorkingIndicator";
import { Markdown } from "../components/chat/Markdown";
import { ReasoningSection } from "../components/chat/ReasoningSection";
import { TaskIndicator } from "../components/chat/TaskIndicator";

type Props = {
  events: EventRecord[];
  /** Max number of message turns to render. */
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

type TurnViewModel = {
  id: string;
  userText: string;
  userAttachments: Attachment[];
  assistantText: string;
  assistantMessageId: string | null;
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

function attachmentsEqual(a: Attachment[], b: Attachment[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];

    if ((av.id ?? null) !== (bv.id ?? null)) return false;
    if ((av.url ?? null) !== (bv.url ?? null)) return false;
    if ((av.mimeType ?? null) !== (bv.mimeType ?? null)) return false;
    if ((av.name ?? null) !== (bv.name ?? null)) return false;
  }

  return true;
}

/** Memoized turn renderer to prevent unnecessary re-renders */
const TurnItem = memo(function TurnItem({
  turn,
  onOpenAttachment,
  streaming,
}: {
  turn: TurnViewModel;
  onOpenAttachment?: (attachment: Attachment) => void;
  streaming?: StreamingTurnProps;
}) {
  const userText = turn.userText;
  const userAttachments = turn.userAttachments;
  const assistantText = turn.assistantText;
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
            <Markdown
              text={assistantDisplayText}
              cacheKey={assistantCacheKey}
              isAnimating={shouldShowStreamingAssistant && streaming?.isStreaming}
            />
          )}
        </div>
      )}
    </div>
  );
});

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
            isAnimating={isStreaming}
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
  // Check if the pending user message already has an assistant reply in events.
  // If so, hide streaming section immediately to prevent duplicate content flash.
  const hasAssistantReply = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return events.some(
      (event) =>
        event.type === "assistant_message" &&
        (event.payload as { userMessageId?: string } | null)?.userMessageId === pendingUserMessageId
    );
  }, [events, pendingUserMessageId]);

  const showStreaming = Boolean((isStreaming || streamingText) && !hasAssistantReply);

  const maxTurns =
    typeof maxItems === "number" ? Math.max(0, Math.floor(maxItems)) : null;

  // Group events into message turns with their associated tool steps.
  const allTurns = useMemo(() => groupEventsIntoTurns(events), [events]);

  const slicedTurns = useMemo(() => {
    if (maxTurns === null) {
      return allTurns;
    }
    if (maxTurns <= 0) {
      return [];
    }

    const baseStart = Math.max(0, allTurns.length - maxTurns);
    if (!showStreaming || !pendingUserMessageId) {
      return allTurns.slice(baseStart);
    }

    const pendingIndex = allTurns.findIndex((turn) => turn.id === pendingUserMessageId);

    // If we have more than `maxTurns` turns and the pending turn would be sliced out,
    // shift the window so the streamed turn stays visible.
    if (pendingIndex !== -1 && pendingIndex < baseStart) {
      const windowEnd = pendingIndex + 1;
      const windowStart = Math.max(0, windowEnd - maxTurns);
      return allTurns.slice(windowStart, windowEnd);
    }

    return allTurns.slice(baseStart);
  }, [allTurns, maxTurns, pendingUserMessageId, showStreaming]);

  // Depseudonymize alias names/identifiers back to real values for display
  const depseudonymize = useDepseudonymize();

  const turnViewCacheRef = useRef<Map<string, TurnViewModel>>(new Map());
  const turns = useMemo(() => {
    const nextCache = new Map<string, TurnViewModel>();
    const viewModels: TurnViewModel[] = [];

    for (const turn of slicedTurns) {
      const userText = getEventText(turn.userMessage);
      const userAttachments = getAttachments(turn.userMessage);
      const assistantText = turn.assistantMessage ? depseudonymize(getEventText(turn.assistantMessage)) : "";
      const assistantMessageId = turn.assistantMessage?._id ?? null;

      const prev = turnViewCacheRef.current.get(turn.id);
      if (
        prev &&
        prev.userText === userText &&
        prev.assistantText === assistantText &&
        prev.assistantMessageId === assistantMessageId &&
        attachmentsEqual(prev.userAttachments, userAttachments)
      ) {
        nextCache.set(turn.id, prev);
        viewModels.push(prev);
        continue;
      }

      const next: TurnViewModel = {
        id: turn.id,
        userText,
        userAttachments,
        assistantText,
        assistantMessageId,
      };
      nextCache.set(turn.id, next);
      viewModels.push(next);
    }

    turnViewCacheRef.current = nextCache;
    return viewModels;
  }, [slicedTurns, depseudonymize]);

  // Depseudonymize streaming and reasoning text for display
  const processedStreamingText = streamingText ? depseudonymize(streamingText) : streamingText;
  const processedReasoningText = reasoningText ? depseudonymize(reasoningText) : reasoningText;

  // Get running tool for streaming indicator
  const runningTool = getCurrentRunningTool(events);

  // Get running tasks for task indicator
  const runningTasks = useMemo(() => getRunningTasks(events), [events]);

  // Use virtualization only when:
  // 1. scrollContainerRef is provided
  // 2. We have enough items to benefit from virtualization
  const shouldVirtualize = scrollContainerRef && turns.length >= VIRTUALIZATION_THRESHOLD;

  const hasPendingTurn = useMemo(() => {
    if (!pendingUserMessageId) return false;
    return turns.some((turn) => turn.id === pendingUserMessageId);
  }, [turns, pendingUserMessageId]);

  const showStandaloneStreaming = Boolean(
    showStreaming && pendingUserMessageId && !hasPendingTurn,
  );

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
    </div>
  );
});
