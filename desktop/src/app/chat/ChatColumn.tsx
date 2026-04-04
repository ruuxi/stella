/**
 * ChatColumn: column-reverse scroll viewport, message rendering, custom scrollbar, composer.
 */

import { memo, useCallback, useMemo, useRef } from "react";
import { ConversationEvents } from "./ConversationEvents";
import { Composer } from "./Composer";
import { StickyThinkingFooter } from "./StickyThinkingFooter";
import { getCurrentRunningTool, getRunningTasks } from "./lib/event-transforms";
import { useAgentSessionStartedAt } from "./hooks/use-agent-session-started-at";
import type { ChatColumnProps } from "./chat-column-types";
import "./full-shell.chat.css";

export type { ChatColumnProps } from "./chat-column-types";

export const ChatColumn = memo(function ChatColumn({
  conversation,
  composer,
  scroll,
  composerEntering,
  conversationId,
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
    // In column-reverse, dragging thumb down means scrolling toward top.
    const scrollDelta = -(dy / trackHeight) * scrollRange;
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
    scrollToBottom,
    thumbState,
  } = scroll;

  // Compute thinking footer data from events (positioned outside content flow to avoid layout shifts)
  const appSessionStartedAtMs = useAgentSessionStartedAt();
  const runningTool = useMemo(() => getCurrentRunningTool(conversation.events), [conversation.events]);
  const runningTasks = useMemo(
    () => getRunningTasks(conversation.events, { appSessionStartedAtMs }),
    [appSessionStartedAtMs, conversation.events],
  );
  const showThinkingFooter = runningTasks.length > 0 || Boolean(conversation.streaming.isStreaming);

  // Capture viewport ref for drag operations
  const assignViewport = useCallback(
    (node: HTMLDivElement | null) => {
      viewportForDragRef.current = node;
      setViewportElement(node);
    },
    [setViewportElement],
  );

  return (
    <div className="full-body-main">
      {/* Viewport region: scroll container + overlays (scrollbar, scroll-to-bottom) */}
      <div className="chat-viewport-region">
        <div
          className="session-content"
          ref={assignViewport}
          onScroll={onScroll}
          style={{ overflowAnchor }}
        >
          <div className="session-messages" ref={setContentElement}>
            <ConversationEvents
              events={conversation.events}
              streamingText={conversation.streaming.text}
              reasoningText={conversation.streaming.reasoningText}
              isStreaming={conversation.streaming.isStreaming}
              pendingUserMessageId={conversation.streaming.pendingUserMessageId}
              selfModMap={conversation.streaming.selfModMap}
              hasOlderEvents={conversation.history.hasOlderEvents}
              isLoadingOlder={conversation.history.isLoadingOlder}
              isLoadingHistory={conversation.history.isInitialLoading}
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

      {/* Thinking footer — between chat and composer, always reserves space */}
      <div className="thinking-footer-overlay">
        {showThinkingFooter && (
          <StickyThinkingFooter
            tasks={runningTasks}
            runningTool={runningTool}
            isStreaming={conversation.streaming.isStreaming}
          />
        )}
      </div>

      {/* Composer: normal flow below the scroll viewport */}
      <div className={composerEntering ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
        <Composer
          message={composer.message}
          setMessage={composer.setMessage}
          chatContext={composer.chatContext}
          setChatContext={composer.setChatContext}
          selectedText={composer.selectedText}
          setSelectedText={composer.setSelectedText}
          isStreaming={conversation.streaming.isStreaming}
          canSubmit={composer.canSubmit}
          conversationId={conversationId}
          onAdd={composer.onAdd}
          onSend={composer.onSend}
          onStop={composer.onStop}
        />
      </div>
    </div>
  );
});

