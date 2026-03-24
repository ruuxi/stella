import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import { ConversationEvents } from "./ConversationEvents";
import "./full-shell.chat.css";
import "./compact-conversation.css";

type CompactConversationVariant = "mini" | "orb";

type CompactConversationSurfaceProps = {
  className: string;
  conversationClassName: string;
  variant: CompactConversationVariant;
  events: EventRecord[];
  maxItems?: number;
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  showConversation?: boolean;
  trackEdges?: boolean;
};

export function CompactConversationSurface({
  className,
  conversationClassName,
  variant,
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
  showConversation = true,
  trackEdges = false,
}: CompactConversationSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const updateEdges = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    const distanceFromBottom = Math.abs(element.scrollTop);
    const distanceFromTop = Math.max(0, maxScroll - distanceFromBottom);
    const nextAtTop = distanceFromTop <= 1;
    const nextAtBottom = distanceFromBottom <= 1;

    shouldAutoScrollRef.current = nextAtBottom;

    if (trackEdges) {
      setAtTop(nextAtTop);
      setAtBottom(nextAtBottom);
    }
  }, [trackEdges]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }

    if (shouldAutoScrollRef.current) {
      element.scrollTop = 0;
    }

    updateEdges();
  }, [
    events.length,
    streamingText,
    reasoningText,
    isStreaming,
    pendingUserMessageId,
    showConversation,
    updateEdges,
  ]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        className,
        showConversation && "has-messages",
        trackEdges && atTop && "at-top",
        trackEdges && atBottom && "at-bottom",
      )}
      style={{ overflowAnchor: shouldAutoScrollRef.current ? "none" : "auto" }}
      onScroll={updateEdges}
    >
      {showConversation ? (
        <div
          className={cn(
            "chat-conversation-surface",
            `chat-conversation-surface--${variant}`,
            conversationClassName,
          )}
        >
          <ConversationEvents
            events={events}
            maxItems={maxItems}
            streamingText={streamingText}
            reasoningText={reasoningText}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
            selfModMap={selfModMap}
            hasOlderEvents={hasOlderEvents}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isLoadingHistory}
          />
        </div>
      ) : null}
    </div>
  );
}
