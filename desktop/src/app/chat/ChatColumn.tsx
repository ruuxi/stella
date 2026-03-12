/**
 * ChatColumn: column-reverse scroll viewport, message rendering, custom scrollbar, composer.
 */

import { memo, useCallback, useRef } from "react";
import { ConversationEvents } from "./ConversationEvents";
import { Composer } from "./Composer";
import { CommandChips } from "@/app/chat/CommandChips";
import { useCommandSuggestions, type CommandSuggestion } from "@/app/chat/hooks/use-command-suggestions";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { ChatContext } from "@/types/electron";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import type { ThumbState } from "@/app/shell/use-full-shell";
import "./full-shell.chat.css";

export type StreamingState = {
  text: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  selfModMap: Record<string, SelfModAppliedData>;
};

export type HistoryState = {
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
};

export type ComposerState = {
  message: string;
  setMessage: (message: string) => void;
  chatContext: ChatContext | null;
  setChatContext: React.Dispatch<React.SetStateAction<ChatContext | null>>;
  selectedText: string | null;
  setSelectedText: React.Dispatch<React.SetStateAction<string | null>>;
  canSubmit: boolean;
  onSend: () => void;
  onStop: () => void;
};

export type ChatColumnProps = {
  events: EventRecord[];
  streaming: StreamingState;
  history: HistoryState;
  composer: ComposerState;
  /** Callback ref — assign to the column-reverse scroll viewport */
  setViewportElement: React.RefCallback<HTMLDivElement>;
  /** Callback ref — assign to the content wrapper inside the viewport */
  setContentElement: React.RefCallback<HTMLDivElement>;
  onScroll: () => void;
  showScrollButton: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** overflow-anchor style for the viewport */
  overflowAnchor: "auto" | "none";
  /** Custom scrollbar thumb state */
  thumbState: ThumbState;
  /** Whether the composer should animate in (e.g. after onboarding exit) */
  composerEntering?: boolean;
  conversationId: string | null;
  onCommandSelect?: (suggestion: CommandSuggestion) => void;
};

export const ChatColumn = memo(function ChatColumn({
  events,
  streaming,
  history,
  composer,
  setViewportElement,
  setContentElement,
  onScroll,
  showScrollButton,
  scrollToBottom,
  overflowAnchor,
  thumbState,
  composerEntering,
  conversationId,
  onCommandSelect,
}: ChatColumnProps) {
  const suggestions = useCommandSuggestions(events, streaming.isStreaming);

  // --- Custom scrollbar thumb drag ---
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ y: number; scrollTop: number } | null>(null);
  const viewportForDragRef = useRef<HTMLDivElement | null>(null);

  // Capture viewport ref for drag operations
  const assignViewport = useCallback(
    (node: HTMLDivElement | null) => {
      viewportForDragRef.current = node;
      setViewportElement(node);
    },
    [setViewportElement],
  );

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
    // In column-reverse, dragging thumb down → scrolling toward top (more negative scrollTop)
    const scrollDelta = -(dy / trackHeight) * scrollRange;
    el.scrollTop = dragStartRef.current.scrollTop + scrollDelta;
  }, []);

  const handleThumbUp = useCallback(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
  }, []);

  return (
    <div className="full-body-main">
      {/* Viewport region — scroll container + overlays (scrollbar, scroll-to-bottom) */}
      <div className="chat-viewport-region">
        <div
          className="session-content"
          ref={assignViewport}
          onScroll={onScroll}
          style={{ overflowAnchor }}
        >
          <div className="session-messages" ref={setContentElement}>
            <ConversationEvents
              events={events}
              streamingText={streaming.text}
              reasoningText={streaming.reasoningText}
              isStreaming={streaming.isStreaming}
              pendingUserMessageId={streaming.pendingUserMessageId}
              selfModMap={streaming.selfModMap}
              hasOlderEvents={history.hasOlderEvents}
              isLoadingOlder={history.isLoadingOlder}
              isLoadingHistory={history.isInitialLoading}
            />
            {!streaming.isStreaming && suggestions.length > 0 && onCommandSelect && (
              <CommandChips
                suggestions={suggestions}
                onSelect={onCommandSelect}
              />
            )}
          </div>
        </div>

        {/* Custom scrollbar thumb overlay */}
        <div className="chat-scrollbar">
          <div
            className={`chat-scrollbar__thumb${thumbState.visible ? " chat-scrollbar__thumb--visible" : ""}`}
            style={{ top: `${thumbState.top}px`, height: `${thumbState.height}px` }}
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

      {/* Composer — normal flow below the scroll viewport */}
      <div className={composerEntering ? "composer-wrap composer-wrap--entering" : "composer-wrap"}>
        <Composer
          message={composer.message}
          setMessage={composer.setMessage}
          chatContext={composer.chatContext}
          setChatContext={composer.setChatContext}
          selectedText={composer.selectedText}
          setSelectedText={composer.setSelectedText}
          isStreaming={streaming.isStreaming}
          canSubmit={composer.canSubmit}
          conversationId={conversationId}
          onSend={composer.onSend}
          onStop={composer.onStop}
        />
      </div>
    </div>
  );
});
