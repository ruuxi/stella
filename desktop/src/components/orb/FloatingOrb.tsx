import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from "react";
import { StellaAnimation, type StellaAnimationHandle } from "@/components/StellaAnimation";

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

interface FloatingOrbProps {
  visible: boolean;
  bubbleText: string | null;
  bubbleOpacity: number;
  isStreaming: boolean;
  onSend: (text: string) => void;
}

export const FloatingOrb = forwardRef<FloatingOrbHandle, FloatingOrbProps>(function FloatingOrb({ visible, bubbleText, bubbleOpacity, isStreaming, onSend }, ref) {
  const [position, setPosition] = useState(loadPosition);
  const [isDragging, setIsDragging] = useState(false);
  const [isInputOpen, setIsInputOpen] = useState(false);
  const [inputText, setInputText] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stellaRef = useRef<StellaAnimationHandle>(null);
  const dragStartRef = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const hasDraggedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    openWithText(text: string) {
      setInputText(text);
      setIsInputOpen(true);
    },
  }));

  // Focus input when opened
  useEffect(() => {
    if (isInputOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isInputOpen]);

  // Close input on Escape
  useEffect(() => {
    if (!isInputOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsInputOpen(false);
        setInputText("");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isInputOpen]);

  // Close input on click outside
  useEffect(() => {
    if (!isInputOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsInputOpen(false);
        setInputText("");
      }
    };
    // Delay to avoid closing on the same click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [isInputOpen]);

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
        // Click — toggle input and flash
        stellaRef.current?.triggerFlash();
        setIsInputOpen((prev) => !prev);
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
    setIsInputOpen(false);
  }, [inputText, onSend]);

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      className="orb-container"
      style={{
        right: `${position.right}px`,
        bottom: `${position.bottom}px`,
      }}
    >
      {bubbleText && (
        <div
          className="orb-bubble"
          style={{ opacity: bubbleOpacity, transition: "opacity 1s ease" }}
        >
          {bubbleText}
        </div>
      )}

      {isInputOpen && (
        <form className="orb-input-form" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            className="orb-input"
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Ask Stella..."
          />
        </form>
      )}

      <div
        className={`orb-body ${isDragging ? "orb-body--dragging" : ""} ${isStreaming ? "orb-body--streaming" : ""}`}
        onMouseDown={handleMouseDown}
      >
        <div className="orb-animation-scale">
          <StellaAnimation ref={stellaRef} width={20} height={20} maxDpr={1} frameSkip={2} />
        </div>
      </div>
    </div>
  );
});
