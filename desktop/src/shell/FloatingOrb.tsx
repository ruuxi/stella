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
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import type { SelfModAppliedData } from "@/app/chat/streaming/streaming-types";
import { StellaAnimation, type StellaAnimationHandle } from "@/shell/ascii-creature/StellaAnimation";
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
  openChat(): void;
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
  onSend: (text: string) => void;
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
      onSend,
    },
    ref,
  ) {
    const [position, setPosition] = useState(loadPosition);
    const [isDragging, setIsDragging] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [inputText, setInputText] = useState("");

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
      openChat() {
        setIsChatOpen(true);
      },
      openWithText(text: string) {
        setInputText(text);
        setIsChatOpen(true);
      },
    }));

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
      if (!isChatOpen) {
        return;
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setIsChatOpen(false);
          setInputText("");
        }
      };

      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [isChatOpen]);

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
        const text = inputText.trim();
        if (!text) {
          return;
        }
        onSend(text);
        setInputText("");
      },
      [inputText, onSend],
    );

    if (!visible) {
      return null;
    }

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

    return (
      <>
        {createPortal(miniChatPanel, document.body)}

        <div
          ref={containerRef}
          className="orb-container"
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
              >
                <textarea
                  ref={inputRef}
                  className="orb-chat-input"
                  value={inputText}
                  rows={1}
                  onChange={(event) => setInputText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSubmit(event);
                    }
                  }}
                  placeholder="Ask Stella..."
                />
              </motion.form>
            )}
          </AnimatePresence>

          <div
            className={`orb-body ${isDragging ? "orb-body--dragging" : ""} ${isStreaming ? "orb-body--streaming" : ""}`}
            onMouseDown={handleMouseDown}
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
      </>
    );
  },
);
