import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import { getCurrentRunningTool } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import type { ChatColumnScroll } from "@/app/chat/chat-column-types";
import { ConversationEvents } from "./ConversationEvents";
import { StickyThinkingFooter } from "./StickyThinkingFooter";
import "./full-shell.chat.css";
import "./compact-conversation.css";

type CompactConversationVariant = "mini" | "orb" | "sidebar";

type CompactConversationSurfaceProps = {
  /**
   * Class for the inner scroll viewport (column-reverse, overflow-y: auto,
   * surface-specific mask gradients). The outer `.chat-viewport-region`
   * wrapper that owns layout/sizing/container-type is fixed.
   */
  className: string;
  conversationClassName: string;
  variant: CompactConversationVariant;
  /**
   * Owned by the parent (e.g. `ChatSidebar` running its own
   * `useChatScrollManagement` instance). Same shape as the full chat —
   * keeps user-bubble pin-to-top, the `100cqh` last-turn floor, and CV
   * virtualization behavior identical across surfaces.
   */
  scroll: ChatColumnScroll;
  events: EventRecord[];
  maxItems?: number;
  streamingText: string;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  selfModMap?: Record<string, SelfModAppliedData>;
  liveTasks?: TaskItem[];
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  showConversation?: boolean;
};

export function CompactConversationSurface({
  className,
  conversationClassName,
  variant,
  scroll,
  events,
  maxItems,
  streamingText,
  isStreaming,
  runtimeStatusText,
  pendingUserMessageId,
  selfModMap,
  liveTasks,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  showConversation = true,
}: CompactConversationSurfaceProps) {
  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const runningTool = useMemo(() => getCurrentRunningTool(events), [events]);
  const footerTasks = useFooterTasks({
    events,
    liveTasks,
    appSessionStartedAtMs,
  });
  const showThinkingFooter =
    footerTasks.length > 0 || Boolean(isStreaming) || Boolean(runtimeStatusText);

  /*
   * Destructure the scroll API up front so the JSX reads plain identifiers
   * (`onScroll`, `overflowAnchor`, etc.) instead of `scroll.X` property
   * accesses. The `react-hooks/refs` lint rule treats `<obj>.<X>` reads
   * inside JSX as potential ref-during-render reads (since `setX` /
   * `onScroll` look ref-like) and flags them; `ChatColumn` does the same
   * destructure for the same reason.
   */
  const {
    setViewportElement,
    setContentElement,
    onScroll,
    isAtBottom,
    overflowAnchor,
  } = scroll;

  return (
    <div
      className={cn(
        "chat-viewport-region",
        `chat-viewport-region--${variant}`,
        showConversation && "has-messages",
      )}
    >
      <div
        ref={setViewportElement}
        className={cn(className, isAtBottom && "at-bottom")}
        style={{ overflowAnchor }}
        onScroll={onScroll}
      >
        {showConversation ? (
          <div
            ref={setContentElement}
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

      {/*
       * Floating thinking footer overlay — same DOM position as the full
       * chat (`ChatColumn`): a sibling of the scroll viewport, absolutely
       * positioned by `.chat-viewport-region .thinking-footer-overlay`.
       * The mask on `.session-content`/`.chat-sidebar-messages` already
       * fades chat content out behind it, so no inner `min-height: 52px`
       * spacer is needed (which would otherwise reserve dead space at the
       * column-reverse bottom — i.e. visually below the latest message).
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
  );
}
