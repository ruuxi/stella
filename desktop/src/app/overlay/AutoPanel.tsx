import { useCallback, useEffect, useRef, useState } from "react";
import { streamChatCompletion } from "@/infra/ai/llm";
import "./auto-panel.css";

type AutoPanelProps = {
  windowText: string;
  windowTitle: string | null;
  onClose: () => void;
};

export function AutoPanel({ windowText, windowTitle, onClose }: AutoPanelProps) {
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    setStreamingText("");
    setIsStreaming(true);
    setError(null);

    const userContent = windowTitle
      ? `[${windowTitle}]\n\n${windowText}`
      : windowText;

    void streamChatCompletion({
      provider: "inception",
      model: "inception/mercury-2",
      agentType: "auto",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant. The user is looking at a window on their computer. Provide a brief, helpful summary or relevant assistance based on the content.",
        },
        { role: "user", content: userContent },
      ],
      onChunk: (chunk) => {
        if (abortRef.current) return;
        setStreamingText((prev) => prev + chunk);
      },
    })
      .catch((err) => {
        if (!abortRef.current) {
          setError(String((err as Error).message || err));
        }
      })
      .finally(() => {
        if (!abortRef.current) {
          setIsStreaming(false);
        }
      });

    return () => {
      abortRef.current = true;
    };
  }, [windowText, windowTitle]);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingText]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  return (
    <div className="auto-panel">
      <div className="auto-panel-header">
        <span className="auto-panel-title">
          {windowTitle ?? "Auto"}
        </span>
        <button
          type="button"
          className="auto-panel-close"
          onClick={handleClose}
          aria-label="Close"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div ref={scrollRef} className="auto-panel-content">
        {error ? (
          <p className="auto-panel-error">{error}</p>
        ) : (
          <div className="auto-panel-text">
            {streamingText || (isStreaming ? "" : "No response.")}
            {isStreaming && <span className="auto-panel-cursor" />}
          </div>
        )}
      </div>
    </div>
  );
}
