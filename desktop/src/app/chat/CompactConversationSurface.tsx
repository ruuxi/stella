import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import {
  getCurrentRunningTool,
} from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import type {
  AgentResponseTarget,
  SelfModAppliedData,
} from "@/app/chat/streaming/streaming-types";
import { ConversationEvents } from "./ConversationEvents";
import { StickyThinkingFooter } from "./StickyThinkingFooter";
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
  streamingResponseTarget?: AgentResponseTarget | null;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
  liveTasks?: TaskItem[];
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
  streamingResponseTarget,
  isStreaming,
  runtimeStatusText,
  pendingUserMessageId,
  selfModMap,
  liveTasks,
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

  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const runningTool = useMemo(() => getCurrentRunningTool(events), [events]);
  const footerTasks = useFooterTasks({
    events,
    liveTasks,
    appSessionStartedAtMs,
  });
  const showThinkingFooter =
    footerTasks.length > 0 || Boolean(isStreaming) || Boolean(runtimeStatusText);

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
            streamingResponseTarget={streamingResponseTarget}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
            selfModMap={selfModMap}
            liveTasks={liveTasks}
            hasOlderEvents={hasOlderEvents}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isLoadingHistory}
          />
          {/*
           * Render the thinking-footer wrapper only when there is something
           * to show. The wrapper itself enforces `min-height: 52px` so that
           * the full-shell composer doesn't shift when the footer toggles —
           * but in the column-reverse compact surface, that reserved height
           * sits at the visual bottom and creates the "empty space below
           * the latest message" effect users see when scrolling.
           */}
          {showThinkingFooter && (
            <div className="thinking-footer-overlay">
              <StickyThinkingFooter
                tasks={footerTasks}
                runningTool={runningTool}
                isStreaming={isStreaming}
                status={runtimeStatusText}
              />
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
