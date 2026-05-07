import { useMemo } from "react";
import { cn } from "@/shared/lib/utils";
import type { EventRecord, TaskItem } from "@/app/chat/lib/event-transforms";
import { getCurrentRunningTool } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import type { QueuedUserMessage } from "@/app/chat/hooks/use-streaming-chat";
import type { ChatColumnScroll } from "@/app/chat/chat-column-types";
import { ConversationEvents } from "./ConversationEvents";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import "./full-shell.chat.css";
import "./compact-conversation.css";

type CompactConversationVariant = "mini" | "orb" | "sidebar";

type CompactConversationSurfaceProps = {
  /**
   * Class applied to the LegendList scroll element (the list IS the
   * scroll viewport). Surfaces use this to layer their mask gradient
   * + scrollbar suppression on top of Legend's own scroller styles.
   */
  className: string;
  /** Style passed to the inner content container (centering, padding, gutters). */
  contentContainerStyle?: React.CSSProperties;
  variant: CompactConversationVariant;
  /**
   * Owned by the parent (e.g. `ChatSidebar` running its own
   * `useChatScrollManagement` instance). Same shape as the full chat
   * so the indicator + thumb behavior stay identical across surfaces.
   */
  scroll: ChatColumnScroll;
  events: EventRecord[];
  maxItems?: number;
  streamingText: string;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  optimisticUserMessageIds?: string[];
  selfModMap?: Record<string, SelfModAppliedData>;
  liveTasks?: TaskItem[];
  hasOlderEvents?: boolean;
  isLoadingOlder?: boolean;
  isLoadingHistory?: boolean;
  showConversation?: boolean;
  /** Estimated row height for first-render layout. Defaults to 96 for compact surfaces. */
  estimatedItemSize?: number;
};

export function CompactConversationSurface({
  className,
  contentContainerStyle,
  variant,
  scroll,
  events,
  maxItems,
  streamingText,
  isStreaming,
  runtimeStatusText,
  pendingUserMessageId,
  queuedUserMessages,
  optimisticUserMessageIds,
  selfModMap,
  liveTasks,
  hasOlderEvents,
  isLoadingOlder,
  isLoadingHistory,
  showConversation = true,
  estimatedItemSize = 96,
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
  const indicatorProps: InlineWorkingIndicatorMountProps = {
    active: hasActiveWork,
    tasks: footerTasks,
    runningTool: runningTool?.tool,
    runningToolId: runningTool?.id,
    isStreaming,
    status: runtimeStatusText,
  };

  return (
    <div
      className={cn(
        "chat-viewport-region",
        `chat-viewport-region--${variant}`,
        showConversation && "has-messages",
      )}
    >
      {showConversation ? (
        <div
          className={cn(
            "chat-conversation-surface",
            `chat-conversation-surface--${variant}`,
          )}
        >
          <ConversationEvents
            events={events}
            maxItems={maxItems}
            streamingText={streamingText}
            isStreaming={isStreaming}
            pendingUserMessageId={pendingUserMessageId}
            queuedUserMessages={queuedUserMessages}
            optimisticUserMessageIds={optimisticUserMessageIds}
            selfModMap={selfModMap}
            hasOlderEvents={hasOlderEvents}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isLoadingHistory}
            indicator={indicatorProps}
            listRef={scroll.listRef}
            onListScroll={scroll.onListScroll}
            onStartReached={scroll.onStartReached}
            className={cn(className, scroll.isAtBottom && "at-bottom")}
            contentContainerStyle={contentContainerStyle}
            estimatedItemSize={estimatedItemSize}
          />
        </div>
      ) : null}
    </div>
  );
}
