/**
 * ChatColumn: column-reverse scroll viewport, message rendering, custom scrollbar, composer.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationEvents } from "./ConversationEvents";
import { Composer } from "./Composer";
import { DropOverlay } from "./DropOverlay";
import { HomeContent } from "@/app/home/HomeContent";
import type { InlineWorkingIndicatorMountProps } from "./InlineWorkingIndicator";
import { getCurrentRunningTool } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import { useFooterTasks } from "./hooks/use-footer-tasks";
import { useFileDrop } from "./hooks/use-file-drop";
import type { ChatColumnProps } from "./chat-column-types";
import "./full-shell.chat.css";

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
  // --- Custom scrollbar thumb drag ---
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const viewportForDragRef = useRef<HTMLDivElement | null>(null);

  const handleThumbDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    const el = viewportForDragRef.current;
    if (!el) return;
    dragStartRef.current = { y: e.clientY, scrollTop: el.scrollTop };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleThumbMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current || !dragStartRef.current) return;
    const el = viewportForDragRef.current;
    if (!el) return;
    const trackHeight = el.clientHeight;
    const scrollRange = el.scrollHeight - el.clientHeight;
    const dy = e.clientY - dragStartRef.current.y;
    // Thumb is inverted to feel natural: dragging down → newer content (scrollTop → 0).
    const scrollDelta = (dy / trackHeight) * scrollRange;
    el.scrollTop = dragStartRef.current.scrollTop + scrollDelta;
  }, []);

  const handleThumbUp = useCallback(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
  }, []);

  const {
    onScroll,
    overflowAnchor,
    setContentElement,
    setViewportElement,
    showScrollButton,
    isAtBottom,
    scrollToBottom,
    thumbState,
  } = scroll;

  // Delay unmount of home content so fade-out can play. Synchronous setState
  // here is intentional — the fade-out timer needs immediate state to drive
  // the leave animation; there's no external system to subscribe to.
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
    // homeVisible intentionally excluded — re-running this effect when it
    // flips would defeat the fade-out timing logic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHomeContent]);

  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const runningTool = useMemo(
    () => getCurrentRunningTool(conversation.events),
    [conversation.events],
  );
  const footerTasks = useFooterTasks({
    events: conversation.events,
    liveTasks: conversation.streaming.liveTasks,
    appSessionStartedAtMs,
  });
  const hasActiveWork =
    footerTasks.length > 0 ||
    Boolean(conversation.streaming.isStreaming) ||
    Boolean(conversation.streaming.runtimeStatusText);
  // Always pass the indicator with `active` reflecting work state.
  // `InlineWorkingIndicator` itself handles the post-active hold +
  // grow-out exit and snapshots its last-known props for the duration
  // of that exit, so it's safe to keep feeding it the live (possibly
  // empty) values from the runtime — when `active` flips false it
  // freezes whichever props it had at that moment.
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

  // Capture viewport ref for drag operations
  const assignViewport = useCallback(
    (node: HTMLDivElement | null) => {
      viewportForDragRef.current = node;
      setViewportElement(node);
    },
    [setViewportElement],
  );

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
      {/* Viewport region: scroll container + overlays (scrollbar, scroll-to-bottom).
          The working indicator now renders inline as the next sibling of the
          latest animating assistant row (Claude pattern), so there's no
          floating overlay to clear at the viewport bottom. */}
      <div className="chat-viewport-region">
        <div
          className={`session-content${isAtBottom ? " at-bottom" : ""}`}
          ref={assignViewport}
          onScroll={onScroll}
          style={{ overflowAnchor }}
        >
          <div className="session-messages" ref={setContentElement}>
            <ConversationEvents
              events={conversation.events}
              streamingText={conversation.streaming.text}
              isStreaming={conversation.streaming.isStreaming}
              pendingUserMessageId={conversation.streaming.pendingUserMessageId}
              queuedUserMessages={conversation.streaming.queuedUserMessages}
              optimisticUserMessageIds={conversation.streaming.optimisticUserMessageIds}
              selfModMap={conversation.streaming.selfModMap}
              hasOlderEvents={conversation.history.hasOlderEvents}
              isLoadingOlder={conversation.history.isLoadingOlder}
              isLoadingHistory={conversation.history.isInitialLoading}
              indicator={indicatorProps}
            />
          </div>
        </div>

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
