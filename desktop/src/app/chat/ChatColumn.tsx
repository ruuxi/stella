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
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { ChevronDown } from "@/ui/icons";
import { ConversationEvents } from "./ConversationEvents";
import { Composer } from "./Composer";
import { HomeContent } from "@/app/home/HomeContent";
import { ChatWorkspaceStrip } from "./ChatWorkspaceStrip";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import { getInlineWorkingIndicatorActive } from "@/features/chat/working-indicator-state";
import { useAgentSessionStartedAt } from "@/features/chat/hooks/use-agent-session-started-at";
import { useFooterTasks } from "@/features/chat/hooks/use-footer-tasks";
import { useFileDrop } from "@/features/chat/hooks/use-file-drop";
import { useReadAloud } from "@/features/voice/services/read-aloud/use-read-aloud";
import type { ChatColumnProps } from "@/features/chat/chat-column-types";
import { useAssistantReplyPeek } from "@/features/chat/hooks/use-assistant-reply-peek";
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
  hideRightContextPanel = false,
  showHomeContent,
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
    thumbRef,
    listRef,
    isFollowingLatest,
  } = scroll;

  const assistantReplyPeek = useAssistantReplyPeek({
    messages: conversation.messages,
    isFollowingLatest,
  });

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
  const footerTasks = useFooterTasks({
    activities: conversation.activity.activities,
    latestMessageTimestampMs: conversation.activity.latestMessageTimestampMs,
    liveTasks: conversation.streaming.liveTasks,
    appSessionStartedAtMs,
  });
  useReadAloud(conversation.messages);
  // Initial thinking is pre-tool only. Once a tool lifecycle begins, the
  // indicator follows live TOOL_START/TOOL_END state instead of the long-lived
  // root run, so spawn_agent/send_input do not pin it while the agent works.
  const isStreaming = Boolean(conversation.streaming.isStreaming);
  const hasToolActivity = Boolean(conversation.streaming.hasToolActivity);
  const isToolActive = Boolean(conversation.streaming.isToolActive);
  const isPreToolThinking =
    isStreaming &&
    !conversation.streaming.isStreamingResponseText &&
    !hasToolActivity;
  const hasActiveWork = getInlineWorkingIndicatorActive({
    isStreaming,
    isStreamingResponseText: Boolean(
      conversation.streaming.isStreamingResponseText,
    ),
    hasToolActivity,
    isToolActive,
  });
  const indicatorProps: InlineWorkingIndicatorMountProps = {
    active: hasActiveWork,
    runningTool: isToolActive
      ? (conversation.streaming.activeToolName ?? undefined)
      : undefined,
    runningToolId: isToolActive
      ? (conversation.streaming.activeToolCallId ?? undefined)
      : undefined,
    status:
      isPreToolThinking || isToolActive
        ? conversation.streaming.runtimeStatusText
        : null,
  };
  const { isDragOver, dropHandlers } = useFileDrop({
    setChatContext: composer.setChatContext,
    disabled: conversation.streaming.isStreaming,
  });

  /**
   * Two synced instances of the (fully controlled) composer: one pinned at
   * the bottom of the persistently-mounted chat, one centered inside the
   * home overlay. Both read the same lifted state, so their content,
   * context chips, and submittability stay identical — only their on-screen
   * position differs. `focusRequestId` is routed to whichever surface is
   * currently active so focus lands on the visible composer, and the
   * off-surface wrapper is `inert` so it stays out of the tab order and
   * can't capture Enter/clicks while hidden.
   */
  const renderComposer = (
    surface: "chat" | "home",
    replyPeek: ComponentProps<typeof Composer>["replyPeek"],
  ) => {
    const isActiveSurface =
      surface === "home" ? showHomeContent : !showHomeContent;
    return (
      <Composer
        message={composer.message}
        setMessage={composer.setMessage}
        chatContext={composer.chatContext}
        setChatContext={composer.setChatContext}
        selectedText={composer.selectedText}
        setSelectedText={composer.setSelectedText}
        isStreaming={conversation.streaming.isStreaming}
        canSubmit={composer.canSubmit}
        focusRequestId={isActiveSurface ? composer.focusRequestId : undefined}
        conversationId={conversationId}
        onSend={composer.onSend}
        onStop={composer.onStop}
        onSelectArea={composer.onSelectArea}
        isDragOver={isDragOver}
        replyPeek={replyPeek}
        suggestionsActive={isActiveSurface}
        tasks={footerTasks}
      />
    );
  };

  const chatReplyPeek = assistantReplyPeek.visible
    ? {
        text: assistantReplyPeek.previewText,
        onJumpToBottom: () => scrollToBottom("smooth"),
        onDismiss: assistantReplyPeek.dismiss,
      }
    : null;

  // Home content is an overlay ON TOP of the always-mounted chat, not a
  // replacement for it — so navigating home and back never unmounts the
  // LegendList. That preserves the user's scroll position and removes the
  // remount flash. The chat content cross-fades under the overlay via
  // opacity (which keeps the scroll node mounted + measurable, unlike
  // `display:none`), while the overlay's own children run their existing
  // enter/leave fades.
  return (
    <div className="full-body-row">
      {/* The whole chat layer (messages + composer + workspace strip +
          scrollbar) fades as one unit under the home overlay. Hiding the
          layer wholesale — rather than toggling the workspace strip's own
          `forceHidden` — avoids re-running the strip's 460ms width/slide
          animation on every home↔chat switch. */}
      <div
        className={`full-body-chat-layer${showHomeContent ? " full-body-chat-layer--hidden" : ""}`}
        inert={showHomeContent || undefined}
      >
        <div className="full-body-main" {...dropHandlers}>
          {/* Viewport region: list + overlay scroll-to-bottom.
            The custom scrollbar deliberately hangs off the layer (sibling
            below) rather than the viewport region so it pins to the
            right edge of the entire chat surface — past the workspace
            strip — instead of sitting at the inside edge of the
            centered chat column. */}
          <div className="chat-viewport-region">
            <ConversationEvents
              messages={conversation.messages}
              pendingUserMessageId={conversation.streaming.pendingUserMessageId}
              queuedUserMessages={conversation.streaming.queuedUserMessages}
              indicator={indicatorProps}
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

            {showScrollButton && !assistantReplyPeek.visible && (
              <button
                className="scroll-to-bottom"
                onClick={() => scrollToBottom("smooth")}
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>

          {/* Composer: normal flow below the scroll viewport */}
          <div
            className={
              composerEntering
                ? "composer-wrap composer-wrap--entering"
                : "composer-wrap"
            }
          >
            {renderComposer("chat", chatReplyPeek)}
          </div>
        </div>
        <ChatWorkspaceStrip
          forceHidden={hideRightContextPanel}
          onNewChat={composer.onNewChat}
          onSelectArea={composer.onSelectArea}
        />

        {/* Custom scrollbar thumb overlay — pinned to the right edge of
          the layer (past the workspace strip) so it tracks the app side
          rather than the inside edge of the chat column. */}
        <div className="chat-scrollbar">
          <div
            ref={thumbRef}
            className="chat-scrollbar__thumb"
            onPointerDown={handleThumbDown}
            onPointerMove={handleThumbMove}
            onPointerUp={handleThumbUp}
            onPointerCancel={handleThumbUp}
          />
        </div>
      </div>

      {homeVisible && (
        <div
          className={`full-body-home-overlay full-body-main--home${homeLeaving ? " full-body-main--home-leaving" : ""}`}
          {...dropHandlers}
        >
          <HomeContent onDismissHome={onDismissHome}>
            <div
              className="composer-wrap"
              inert={showHomeContent ? undefined : true}
            >
              {renderComposer("home", null)}
            </div>
          </HomeContent>
        </div>
      )}
    </div>
  );
});
