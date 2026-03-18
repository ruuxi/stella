import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/shared/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "./Markdown";
import { GrowIn } from "./GrowIn";
import { TextShimmer } from "./TextShimmer";

interface ReasoningSectionProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

export function ReasoningSection({
  content,
  isStreaming = false,
  className,
}: ReasoningSectionProps) {
  // Track if user has manually collapsed - if not, auto-expand when streaming
  const [userCollapsed, setUserCollapsed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  // Determine if expanded: streaming always shows, or user hasn't collapsed
  const expanded = isStreaming || !userCollapsed;
  const visible = isStreaming || expanded;

  // Auto-scroll to bottom when content updates during streaming
  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, isStreaming]);

  const handleToggle = useCallback(() => {
    setUserCollapsed((prev) => !prev);
  }, []);

  if (!content && !isStreaming) return null;

  return (
    <GrowIn animate={isStreaming}>
      <div
        className={cn("reasoning-section", className)}
        data-streaming={isStreaming}
        data-expanded={expanded}
      >
        {/* Streaming: show animated "Thinking" heading with per-char shimmer */}
        {isStreaming && (
          <div className="reasoning-heading-stream">
            <TextShimmer text="Thinking" active={isStreaming} className="reasoning-heading-text" />
          </div>
        )}

        {/* Only show trigger button when not streaming */}
        {!isStreaming && (
          <button
            type="button"
            className="reasoning-trigger"
            onClick={handleToggle}
          >
            <span>Reasoning</span>
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        )}

        {/* Use data-visible transition for smooth show/hide */}
        <div
          className="reasoning-body"
          data-visible={visible}
        >
          <div ref={contentRef} className="reasoning-content">
            {content && (
              <Markdown text={content} isAnimating={isStreaming} />
            )}
          </div>
        </div>
      </div>
    </GrowIn>
  );
}
