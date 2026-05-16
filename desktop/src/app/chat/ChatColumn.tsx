/**
 * ChatColumn: virtualized chat viewport (Legend List v3 web entry),
 * custom scrollbar overlay, composer.
 *
 * Layout:
 *   .full-body-main
 *     .chat-viewport-region (relative; hosts the absolute scrollbar +
 *       scroll-to-bottom button overlays)
 *       <ConversationEvents> → <ChatTimeline> → <LegendList />
 *     .composer-wrap
 *
 * The list element itself is the scroll container — there is no
 * column-reverse wrapper anymore. `useChatScrollManagement` drives the
 * thumb / at-bottom state from Legend's `onScroll` synthetic event and
 * `getState()` snapshot rather than reading `scrollTop` from a manual
 * div.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConversationEvents } from "./ConversationEvents";
import { Composer } from "./Composer";
import { DropOverlay } from "./DropOverlay";
import { HomeContent } from "@/app/home/HomeContent";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import { getCurrentRunningTool } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import { useFileDrop } from "./hooks/use-file-drop";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import type { ChatColumnProps } from "./chat-column-types";
import "./full-shell.chat.css";

/**
 * Inline content-container style for Legend List.
 *
 * Important: Legend sums `paddingTop`/`paddingBottom` as numbers when
 * computing `contentLength`. Strings like `"112px"` get string-concat'd
 * (`"25656" + "112px" + "30px"`) and the resulting non-numeric
 * `contentLength` poisons every "is at end" / "scroll target" computation
 * and stops items from rendering. Always pass paddings as numbers (px).
 */
const FULL_CHAT_CONTENT_STYLE = {
  maxWidth: "min(50rem, 100%)",
  marginLeft: "auto",
  marginRight: "auto",
  paddingLeft: 24,
  paddingRight: 24,
  paddingTop: 112,
  paddingBottom: 30,
} as const;

export const ChatColumn = memo(function ChatColumn({
  conversation,
  composer,
  scroll,
  composerEntering,
  conversationId,
  showHomeContent,
  onSuggestionClick,
  onDismissHome,
}: ChatColumnProps) {
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ y: number; scrollTop: number } | null>(null);

  /**
   * The Legend List exposes its scroll element via `getScrollableNode()`.
   * We only need it inside drag handlers, so we resolve lazily rather
   * than caching a ref that could go stale across surface remounts.
   */
  const getScrollNode = useCallback((): HTMLElement | null => {
    const list = scroll.listRef.current;
    if (!list) return null;
    return list.getScrollableNode();
  }, [scroll.listRef]);

  const handleThumbDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = getScrollNode();
      if (!el) return;
      isDraggingRef.current = true;
      dragStartRef.current = { y: e.clientY, scrollTop: el.scrollTop };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [getScrollNode],
  );

  const handleThumbMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDraggingRef.current || !dragStartRef.current) return;
      const el = getScrollNode();
      if (!el) return;
      const trackHeight = el.clientHeight;
      const scrollRange = Math.max(1, el.scrollHeight - el.clientHeight);
      const dy = e.clientY - dragStartRef.current.y;
      const scrollDelta = (dy / trackHeight) * scrollRange;
      const next = Math.max(
        0,
        Math.min(scrollRange, dragStartRef.current.scrollTop + scrollDelta),
      );
      el.scrollTop = next;
    },
    [getScrollNode],
  );

  const handleThumbUp = useCallback(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
  }, []);

  const {
    onListScroll,
    showScrollButton,
    scrollToBottom,
    thumbState,
    listRef,
  } = scroll;

  /**
   * Delay unmount of home content so the fade-out can play. Synchronous
   * setState here is intentional — the fade-out timer needs immediate
   * state to drive the leave animation; there's no external system to
   * subscribe to.
   */
  const [homeVisible, setHomeVisible] = useState(Boolean(showHomeContent));
  const [homeLeaving, setHomeLeaving] = useState(false);

  useEffect(() => {
    if (showHomeContent) {
      setHomeLeaving(false);
      setHomeVisible(true);
    } else if (homeVisible) {
      setHomeLeaving(true);
      const timer = setTimeout(() => {
        setHomeVisible(false);
        setHomeLeaving(false);
      }, 280);
      return () => clearTimeout(timer);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHomeContent]);

  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const runningTool = useMemo(
    () => getCurrentRunningTool(conversation.messages),
    [conversation.messages],
  );
  const footerTasks = useFooterTasks({
    activities: conversation.activity.activities,
    latestMessageTimestampMs:
      conversation.activity.latestMessageTimestampMs,
    liveTasks: conversation.streaming.liveTasks,
    appSessionStartedAtMs,
  });
  useReadAloud(conversation.messages);
  const hasActiveWork =
    footerTasks.length > 0 ||
    Boolean(conversation.streaming.isStreaming) ||
    Boolean(conversation.streaming.runtimeStatusText);
  const indicatorProps: InlineWorkingIndicatorMountProps = {
    active: hasActiveWork,
    tasks: footerTasks,
    runningTool: runningTool?.tool,
    runningToolId: runningTool?.id,
    isStreaming: conversation.streaming.isStreaming,
    status: conversation.streaming.runtimeStatusText,
  };
  const shouldShowHomeContent = homeVisible;
  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext: composer.setChatContext,
    disabled: conversation.streaming.isStreaming,
  });

  const composerElement = (
    <Composer
      message={composer.message}
      setMessage={composer.setMessage}
      chatContext={composer.chatContext}
      setChatContext={composer.setChatContext}
      selectedText={composer.selectedText}
      setSelectedText={composer.setSelectedText}
      isStreaming={conversation.streaming.isStreaming}
      canSubmit={composer.canSubmit}
      focusRequestId={composer.focusRequestId}
      conversationId={conversationId}
      onSend={composer.onSend}
      onStop={composer.onStop}
      indicator={indicatorProps}
    />
  );

  if (shouldShowHomeContent && onSuggestionClick) {
    return (
      <div
        className={`full-body-main full-body-main--home${homeLeaving ? " full-body-main--home-leaving" : ""}`}
        {...dropHandlers}
      >
        <DropOverlay visible={isDragOver} variant="surface" />
        <HomeContent
          conversationId={conversationId}
          onDismissHome={onDismissHome}
          onSuggestionClick={onSuggestionClick}
        >
          <div className={composerEntering ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
            {composerElement}
          </div>
        </HomeContent>
      </div>
    );
  }

  return (
    <div className="full-body-main" {...dropHandlers}>
      <DropOverlay visible={isDragOver} variant="surface" />
      {/* Viewport region: list + overlays (custom scrollbar, scroll-to-bottom). */}
      <div className="chat-viewport-region">
        <ConversationEvents
          messages={conversation.messages}
          streamingText={conversation.streaming.text}
          isStreaming={conversation.streaming.isStreaming}
          pendingUserMessageId={conversation.streaming.pendingUserMessageId}
          queuedUserMessages={conversation.streaming.queuedUserMessages}
          optimisticUserMessageIds={conversation.streaming.optimisticUserMessageIds}
          hasOlderMessages={conversation.history.hasOlderMessages}
          isLoadingOlder={conversation.history.isLoadingOlder}
          isLoadingHistory={conversation.history.isInitialLoading}
          listRef={listRef}
          onListScroll={onListScroll}
          onStartReached={scroll.onStartReached}
          className="session-content"
          contentContainerStyle={FULL_CHAT_CONTENT_STYLE}
          estimatedItemSize={140}
        />

        {/* Custom scrollbar thumb overlay */}
        <div className="chat-scrollbar">
          <div
            className={`chat-scrollbar__thumb${thumbState.visible ? " chat-scrollbar__thumb--visible" : ""}`}
            style={{
              top: `${thumbState.top}px`,
              height: `${thumbState.height}px`,
            }}
            onPointerDown={handleThumbDown}
            onPointerMove={handleThumbMove}
            onPointerUp={handleThumbUp}
            onPointerCancel={handleThumbUp}
          />
        </div>

        {showScrollButton && (
          <button
            className="scroll-to-bottom"
            onClick={() => scrollToBottom("smooth")}
            aria-label="Scroll to bottom"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}

      </div>

      {/* Composer: normal flow below the scroll viewport */}
      <div className={composerEntering ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
        {composerElement}
      </div>
    </div>
  );
});
