import { cn } from "@/shared/lib/utils";
import type { MessageRecord } from "../../../../runtime/contracts/local-chat.js";
import type { QueuedUserMessage } from "@/features/chat/hooks/use-streaming-chat";
import type { ChatColumnScroll } from "@/features/chat/chat-column-types";
import { ConversationEvents } from "@/app/chat/ConversationEvents";
import type { InlineWorkingIndicatorMountProps } from "@/app/chat/InlineWorkingIndicator";
import "@/app/chat/full-shell.chat.css";
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
  messages: MessageRecord[];
  conversationId?: string | null;
  maxItems?: number;
  isStreaming: boolean;
  runtimeStatusText?: string | null;
  pendingUserMessageId: string | null;
  queuedUserMessages?: QueuedUserMessage[];
  /** Working/agent indicator rendered below the last assistant message. */
  indicator?: InlineWorkingIndicatorMountProps;
  hasOlderMessages?: boolean;
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
  messages,
  conversationId,
  maxItems,
  pendingUserMessageId,
  queuedUserMessages,
  indicator,
  hasOlderMessages,
  isLoadingOlder,
  isLoadingHistory,
  showConversation = true,
  estimatedItemSize = 96,
}: CompactConversationSurfaceProps) {
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
            messages={messages}
            conversationId={conversationId}
            maxItems={maxItems}
            pendingUserMessageId={pendingUserMessageId}
            queuedUserMessages={queuedUserMessages}
            indicator={indicator}
            hasOlderMessages={hasOlderMessages}
            isLoadingOlder={isLoadingOlder}
            isLoadingHistory={isLoadingHistory}
            listRef={scroll.listRef}
            onListScroll={scroll.onListScroll}
            onStartReached={scroll.onStartReached}
            className={className}
            contentContainerStyle={contentContainerStyle}
            estimatedItemSize={estimatedItemSize}
          />
        </div>
      ) : null}
    </div>
  );
}
