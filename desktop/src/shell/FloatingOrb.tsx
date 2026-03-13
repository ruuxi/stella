import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { StellaAnimation, type StellaAnimationHandle } from "@/shell/ascii-creature/StellaAnimation";
import { Markdown } from "@/app/chat/Markdown";
import { getDisplayMessageText } from "@/app/chat/MessageTurn";
import type { EventRecord } from "@/app/chat/lib/event-transforms";
import "./floating-orb.css";

const ORB_POSITION_KEY = "stella:orb-position";
const DEFAULT_OFFSET = { right: 32, bottom: 32 };
const DRAG_THRESHOLD = 5;

function loadPosition(): { right: number; bottom: number } {
  try {
    const stored = localStorage.getItem(ORB_POSITION_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_OFFSET;
}

function savePosition(pos: { right: number; bottom: number }) {
  try {
    localStorage.setItem(ORB_POSITION_KEY, JSON.stringify(pos));
  } catch { /* ignore */ }
}

export interface FloatingOrbHandle {
  openWithText(text: string): void;
}

type MiniChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

interface FloatingOrbProps {
  visible: boolean;
  events: EventRecord[];
  streamingText: string;
  isStreaming: boolean;
  onSend: (text: string) => void;
}

function extractChatMessages(events: EventRecord[]): MiniChatMessage[] {
  const messages: MiniChatMessage[] = [];
  for (const event of events) {
    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = getDisplayMessageText(event);
      if (!text.trim()) continue;
      // Skip system-like messages (e.g. "[System: ...")
      if (text.startsWith("[System:")) continue;
      messages.push({
        id: event._id,
        role: event.type === "user_message" ? "user" : "assistant",
        text,
      });
    }
  }
  return messages;
}

export const FloatingOrb = forwardRef<FloatingOrbHandle, FloatingOrbProps>(function FloatingOrb(
  { visible, events, streamingText, isStreaming, onSend },
  ref,
) {
  const [position, setPosition] = useState(loadPosition);
  const [isDragging, setIsDragging] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [inputText, setInputText] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stellaRef = useRef<StellaAnimationHandle>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const hasDraggedRef = useRef(false);

  const chatMessages = useMemo(() => extractChatMessages(events), [events]);

  useImperativeHandle(ref, () => ({
    openWithText(text: string) {
      setInputText(text);
      setIsChatOpen(true);
    },
  }));

  // Focus input when chat opened
  useEffect(() => {
    if (isChatOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isChatOpen]);

  // Track whether the chat was just opened so we can skip the smooth scroll
  const justOpenedRef = useRef(false);

  // When chat opens, mark it and instant-scroll on next frame
  useEffect(() => {
    if (isChatOpen) {
      justOpenedRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      });
    }
  }, [isChatOpen]);

  // Smooth-scroll only for new messages / streaming updates (not on open)
  useEffect(() => {
    if (!isChatOpen) return;
    if (justOpenedRef.current) {
      justOpenedRef.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [isChatOpen, chatMessages.length, streamingText]);

  // Close on Escape
  useEffect(() => {
    if (!isChatOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsChatOpen(false);
        setInputText("");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isChatOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isChatOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inOrb = containerRef.current?.contains(target);
      const inChat = chatPanelRef.current?.contains(target);
      if (!inOrb && !inChat) {
        setIsChatOpen(false);
        setInputText("");
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [isChatOpen]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    hasDraggedRef.current = false;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      right: position.right,
      bottom: position.bottom,
    };
    setIsDragging(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;
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
        // Click — toggle chat and flash
        stellaRef.current?.triggerFlash();
        setIsChatOpen((prev) => !prev);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [position]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text) return;
    onSend(text);
    setInputText("");
  }, [inputText, onSend]);

  if (!visible) return null;

  const hasStreamingContent = isStreaming && streamingText.trim().length > 0;

  // Chat messages panel — above the orb, wider (spans from left edge to orb right)
  const miniChatPanel = (
    <AnimatePresence>
      {isChatOpen && (
        <motion.div
          ref={chatPanelRef}
          key="orb-mini-chat"
          className="orb-mini-chat"
          style={{
            right: `${position.right}px`,
            bottom: `${position.bottom + 64}px`,
          }}
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.97 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
        >
          <div className="orb-chat-messages">
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={`orb-msg orb-msg--${msg.role}`}
              >
                {msg.role === "assistant" ? (
                  <Markdown text={msg.text} enableEmotes />
                ) : (
                  msg.text
                )}
              </div>
            ))}

            {hasStreamingContent && (
              <div className="orb-msg orb-msg--assistant orb-msg--streaming">
                <Markdown text={streamingText} isAnimating enableEmotes />
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

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
              key="orb-input-bar"
              className="orb-chat-input-form"
              style={{ transformOrigin: "right center" }}
              initial={{ opacity: 0, scaleX: 0.5 }}
              animate={{ opacity: 1, scaleX: 1 }}
              exit={{ opacity: 0, scaleX: 0.5 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              onSubmit={handleSubmit}
            >
              <input
                ref={inputRef}
                className="orb-chat-input"
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
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
            <StellaAnimation ref={stellaRef} width={20} height={20} maxDpr={1} frameSkip={2} />
          </div>
        </div>
      </div>
    </>
  );
});
