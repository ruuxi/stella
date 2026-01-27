import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

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
  const [expanded, setExpanded] = useState(isStreaming);

  if (!content && !isStreaming) return null;

  return (
    <div
      className={cn("reasoning-section", className)}
      data-streaming={isStreaming}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="reasoning-trigger"
        onClick={() => setExpanded(!expanded)}
      >
        <span>Reasoning</span>
        {expanded ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>

      {expanded && (
        <div className="reasoning-body">
          <div className="reasoning-content">
            {content || "Thinking..."}
          </div>
        </div>
      )}
    </div>
  );
}
