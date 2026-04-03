import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import { ConversationEvents } from "./ConversationEvents";
import "./full-shell.chat.css";
import "./compact-conversation.css";

type CompactConversationVariant = "mini" | "orb" | "sidebar";

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

  // Use a ResizeObserver for auto-scroll instead of tracking streamingText
  // in a blocking useLayoutEffect. Content resizes drive the scroll, avoiding
  // synchronous layout on every streaming chunk.
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    const scroll = scrollRef.current;
    if (!content || !scroll) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScrollRef.current) {
        scroll.scrollTop = 0;
      }
      updateEdges();
    });

    observer.observe(content);
    return () => observer.disconnect();
  }, [updateEdges, showConversation]);

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
          ref={contentRef}
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
