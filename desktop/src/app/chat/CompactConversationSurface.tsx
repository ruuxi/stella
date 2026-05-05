import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import { getCurrentRunningTool } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import type { ChatColumnScroll } from "@/app/chat/chat-column-types";
import { ConversationEvents } from "./ConversationEvents";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
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
   * `useChatScrollManagement` instance). Same shape as the full chat
   * so CV virtualization and ResizeObserver follow behavior stay
   * identical across surfaces.
   */
  scroll: ChatColumnScroll;
  events: EventRecord[];
  maxItems?: number;
  streamingText: string;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  optimisticUserMessageIds?: string[];
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
  optimisticUserMessageIds,
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
  const hasActiveWork =
    footerTasks.length > 0 ||
    Boolean(isStreaming) ||
    Boolean(runtimeStatusText);
  // See note in `ChatColumn.tsx`: pass the indicator unconditionally
  // and toggle `active` so the component can play its exit animation.
  const indicatorProps: InlineWorkingIndicatorMountProps = {
    active: hasActiveWork,
    tasks: footerTasks,
    runningTool: runningTool?.tool,
    runningToolId: runningTool?.id,
    isStreaming,
    status: runtimeStatusText,
  };

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
              optimisticUserMessageIds={optimisticUserMessageIds}
              selfModMap={selfModMap}
              hasOlderEvents={hasOlderEvents}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isLoadingHistory}
              indicator={indicatorProps}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
