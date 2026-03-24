import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { CompactConversationSurface } from "@/app/chat/CompactConversationSurface";
import {
  ComposerAddButton,
  ComposerTextarea,
} from "@/app/chat/ComposerPrimitives";
import {
  FileContextChips,
  ScreenshotContextChips,
} from "@/app/chat/ComposerContextChips";
import { ComposerWindowContextSection } from "@/app/chat/ComposerContextSections";
import { deriveComposerState } from "@/app/chat/composer-context";
import { useFileDrop } from "@/app/chat/hooks/use-file-drop";
import { DropOverlay } from "@/app/chat/DropOverlay";
import type { ChatContext } from "@/shared/types/electron";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import { StellaAnimation, type StellaAnimationHandle } from "@/shell/ascii-creature/StellaAnimation";
import { NotificationPanel } from "@/shell/notifications/NotificationPanel";
import { useActivityData } from "@/shell/notifications/use-activity-data";
import "./floating-orb.css";

const ORB_POSITION_KEY = "stella:orb-position";
const DEFAULT_OFFSET = { right: 32, bottom: 32 };
const DRAG_THRESHOLD = 5;

function loadPosition(): { right: number; bottom: number } {
  try {
    const stored = localStorage.getItem(ORB_POSITION_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    /* ignore */
  }
  return DEFAULT_OFFSET;
}

function savePosition(pos: { right: number; bottom: number }) {
  try {
    localStorage.setItem(ORB_POSITION_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

export interface FloatingOrbHandle {
  openChat(chatContext?: ChatContext | null): void;
  closeChat(): void;
  openWithText(text: string): void;
}

interface FloatingOrbProps {
  visible: boolean;
  events: EventRecord[];
  streamingText: string;
  reasoningText: string;
  isStreaming: boolean;
  pendingUserMessageId: string | null;
  selfModMap: Record<string, SelfModAppliedData>;
  hasOlderEvents: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  conversationId?: string;
  onSend: (text: string, chatContext?: ChatContext | null) => void;
  onAdd?: () => void;
  onChatOpenChange?: (open: boolean) => void;
}

export const FloatingOrb = forwardRef<FloatingOrbHandle, FloatingOrbProps>(
  function FloatingOrb(
    {
      visible,
      events,
      streamingText,
      reasoningText,
      isStreaming,
      pendingUserMessageId,
      selfModMap,
      hasOlderEvents,
      isLoadingOlder,
      isInitialLoading,
      conversationId,
      onSend,
      onAdd,
      onChatOpenChange,
    },
    ref,
  ) {
    const [position, setPosition] = useState(loadPosition);
    const [isDragging, setIsDragging] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [isNotifOpen, setIsNotifOpen] = useState(false);
    const [inputText, setInputText] = useState("");
    const [orbChatContext, setOrbChatContext] = useState<ChatContext | null>(null);
    const activityData = useActivityData(conversationId);

    const { isDragOver, isWindowDragActive, dropHandlers } = useFileDrop({
      setChatContext: setOrbChatContext,
      disabled: isStreaming,
    });

    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const formRef = useRef<HTMLFormElement>(null);
    const stellaRef = useRef<StellaAnimationHandle>(null);
    const [inputBarHeight, setInputBarHeight] = useState(56);
    const dragStartRef = useRef<{
      x: number;
      y: number;
      right: number;
      bottom: number;
    } | null>(null);
    const hasDraggedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      openChat(chatContext?: ChatContext | null) {
        if (chatContext !== undefined) {
          setOrbChatContext(chatContext);
        }
        setIsChatOpen(true);
        setIsNotifOpen(false);
      },
      closeChat() {
        setIsChatOpen(false);
        setInputText("");
        setOrbChatContext(null);
      },
      openWithText(text: string) {
        setInputText(text);
        setIsChatOpen(true);
        setIsNotifOpen(false);
      },
    }));

    useEffect(() => {
      onChatOpenChange?.(isChatOpen);
    }, [isChatOpen, onChatOpenChange]);

    // Track input bar height so the chat panel adjusts upward.
    useEffect(() => {
      const form = formRef.current;
      if (!form || typeof ResizeObserver === "undefined") {
        return;
      }

      const resizeObserver = new ResizeObserver((entries) => {
        const height =
          entries[0]?.borderBoxSize?.[0]?.blockSize ??
          entries[0]?.contentRect.height;
        if (height && height > 0) {
          setInputBarHeight(height);
        }
      });

      resizeObserver.observe(form);
      return () => resizeObserver.disconnect();
    }, [isChatOpen]);

    useEffect(() => {
      if (isChatOpen && inputRef.current) {
        inputRef.current.focus();
      }
    }, [isChatOpen]);

    useEffect(() => {
      if (!isChatOpen && !isNotifOpen) {
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          if (isNotifOpen) {
            setIsNotifOpen(false);
          }
          if (isChatOpen) {
            setIsChatOpen(false);
            setInputText("");
          }
        }
      };

      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isChatOpen, isNotifOpen]);

    const handleMouseDown = useCallback(
      (event: React.MouseEvent) => {
        event.preventDefault();
        hasDraggedRef.current = false;
        dragStartRef.current = {
          x: event.clientX,
          y: event.clientY,
          right: position.right,
          bottom: position.bottom,
        };
        setIsDragging(true);

        const handleMouseMove = (moveEvent: MouseEvent) => {
          if (!dragStartRef.current) {
            return;
          }

          const dx = moveEvent.clientX - dragStartRef.current.x;
          const dy = moveEvent.clientY - dragStartRef.current.y;
          if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
            hasDraggedRef.current = true;
          }

          if (hasDraggedRef.current) {
            const newRight = Math.max(0, dragStartRef.current.right - dx);
            const newBottom = Math.max(0, dragStartRef.current.bottom - dy);
            setPosition({ right: newRight, bottom: newBottom });
          }
        };

        const handleMouseUp = () => {
          setIsDragging(false);
          dragStartRef.current = null;
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
          if (hasDraggedRef.current) {
            setPosition((pos) => {
              savePosition(pos);
              return pos;
            });
          } else {
            stellaRef.current?.triggerFlash();
            setIsChatOpen((prev) => !prev);
          }
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
      },
      [position],
    );

    const handleSubmit = useCallback(
      (event: React.FormEvent) => {
        event.preventDefault();
        const { canSubmit, trimmedMessage } = deriveComposerState({
          message: inputText,
          chatContext: orbChatContext,
        });
        if (!canSubmit) {
          return;
        }
        onSend(trimmedMessage, orbChatContext);
        setInputText("");
        setOrbChatContext(null);
      },
      [inputText, orbChatContext, onSend],
    );

    const orbComposerState = deriveComposerState({
      message: inputText,
      chatContext: orbChatContext,
    });

    if (!visible) {
      return null;
    }

    const hasContextChips = Boolean(
      orbChatContext?.window ||
      orbChatContext?.regionScreenshots?.length ||
      orbChatContext?.files?.length,
    );

    const miniChatPanel = (
      <AnimatePresence>
        {isChatOpen && (
          <motion.div
            key="orb-mini-chat"
            className="orb-mini-chat"
            style={{
              right: `${position.right}px`,
              bottom: `${position.bottom + inputBarHeight + 8}px`,
            }}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
          >
            <CompactConversationSurface
              className="orb-chat-messages"
              conversationClassName="orb-conversation"
              variant="orb"
              events={events}
              streamingText={streamingText}
              reasoningText={reasoningText}
              isStreaming={isStreaming}
              pendingUserMessageId={pendingUserMessageId}
              selfModMap={selfModMap}
              hasOlderEvents={hasOlderEvents}
              isLoadingOlder={isLoadingOlder}
              isLoadingHistory={isInitialLoading}
            />
          </motion.div>
        )}
      </AnimatePresence>
    );

    /*
     * When chat is closed the orb body itself becomes the drop target so
     * the user can drop files directly onto it. Dropping opens the chat
     * and attaches the files. `isWindowDragActive` enables pointer-events
     * on the container so the orb body can receive drag events.
     */
    const orbBodyDropHandlers = isChatOpen
      ? {}
      : {
          ...dropHandlers,
          onDrop: (e: React.DragEvent) => {
            setIsChatOpen(true);
            dropHandlers.onDrop(e);
          },
        };

    const handleNotifClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsNotifOpen((prev) => !prev);
      if (!isNotifOpen) setIsChatOpen(false);
    };

    const notifPanel = (
      <NotificationPanel
        open={isNotifOpen && !isChatOpen}
        data={activityData}
        position={position}
        orbSize={56}
      />
    );

    return (
      <>
        {createPortal(miniChatPanel, document.body)}
        {createPortal(notifPanel, document.body)}

        <div
          ref={containerRef}
          className={`orb-container${!isChatOpen && isWindowDragActive ? " orb-container--drop-active" : ""}`}
          style={{
            right: `${position.right}px`,
            bottom: `${position.bottom}px`,
          }}
        >
          <AnimatePresence>
            {isChatOpen && (
              <motion.form
                ref={formRef}
                key="orb-input-bar"
                className="orb-chat-input-form"
                style={{ transformOrigin: "right center" }}
                initial={{ opacity: 0, scaleX: 0.5 }}
                animate={{ opacity: 1, scaleX: 1 }}
                exit={{ opacity: 0, scaleX: 0.5 }}
                transition={{ type: "spring", duration: 0.3, bounce: 0 }}
                onSubmit={handleSubmit}
                {...dropHandlers}
              >
                <DropOverlay visible={isDragOver} variant="orb" />

                {hasContextChips && (
                  <div className="orb-chat-attachments">
                    <ComposerWindowContextSection
                      variant="mini"
                      chatContext={orbChatContext}
                      setChatContext={setOrbChatContext}
                    />
                    {(orbChatContext?.regionScreenshots?.length ?? 0) > 0 && (
                      <ScreenshotContextChips
                        screenshots={orbChatContext!.regionScreenshots!}
                        setChatContext={setOrbChatContext}
                        chipClassName="chat-composer-context-chip chat-composer-context-chip--screenshot mini-context-chip mini-context-chip--screenshot"
                        imageClassName="chat-composer-context-thumb mini-context-thumb"
                        removeClassName="chat-composer-context-remove mini-context-remove"
                      />
                    )}
                    {(orbChatContext?.files?.length ?? 0) > 0 && (
                      <FileContextChips
                        files={orbChatContext!.files!}
                        setChatContext={setOrbChatContext}
                        chipClassName="mini-context-chip"
                        removeClassName="chat-composer-context-remove mini-context-remove"
                      />
                    )}
                  </div>
                )}

                <ComposerAddButton
                  className="orb-chat-add"
                  title="Add"
                  onClick={onAdd}
                />
                <ComposerTextarea
                  ref={inputRef}
                  className="orb-chat-input"
                  tone="orb"
                  value={inputText}
                  rows={1}
                  onChange={(event) => setInputText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSubmit(event);
                    }
                  }}
                  placeholder={orbComposerState.placeholder}
                />
              </motion.form>
            )}
          </AnimatePresence>

          <div className="orb-body-wrapper">
            <button
              className={`notif-bell${isNotifOpen && !isChatOpen ? " notif-bell--active" : ""}`}
              onClick={handleNotifClick}
              aria-label="Notifications"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 13a2 2 0 0 0 4 0" />
                <path d="M12 6c0-2.2-1.8-4-4-4S4 3.8 4 6c0 3.1-1.3 4.5-2 5h12c-.7-.5-2-1.9-2-5Z" />
              </svg>

            </button>
            <div
              className={`orb-body ${isDragging ? "orb-body--dragging" : ""} ${isStreaming ? "orb-body--streaming" : ""}`}
              onMouseDown={handleMouseDown}
              {...orbBodyDropHandlers}
            >
              <div className="orb-animation-scale">
                <StellaAnimation
                  ref={stellaRef}
                  width={20}
                  height={20}
                  maxDpr={1}
                  frameSkip={2}
                />
              </div>
            </div>
          </div>
        </div>
      </>
    );
  },
);
