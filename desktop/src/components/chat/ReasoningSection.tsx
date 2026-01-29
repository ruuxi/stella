import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "./Markdown";

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
    <div
      className={cn("reasoning-section", className)}
      data-streaming={isStreaming}
      data-expanded={expanded}
    >
      {/* Only show trigger button when not streaming (Aura behavior) */}
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

      {(isStreaming || expanded) && (
        <div className="reasoning-body">
          <div ref={contentRef} className="reasoning-content">
            {content ? (
              <Markdown text={content} />
            ) : (
              "Thinking..."
            )}
          </div>
        </div>
      )}
    </div>
  );
}
