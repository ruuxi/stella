import { useCallback, useEffect, useRef, useState } from "react";
import { streamChatCompletion } from "@/infra/ai/llm";
import { Markdown } from "@/app/chat/Markdown";
import "./auto-panel.css";

type AutoPanelProps = {
  windowText: string;
  windowTitle: string | null;
  onClose: () => void;
};

function SkeletonLoader() {
  return (
    <div className="auto-panel-skeleton">
      <div className="auto-panel-skeleton-block">
        <div className="auto-panel-skeleton-line" style={{ width: "45%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "92%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "80%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "88%" }} />
      </div>
      <div className="auto-panel-skeleton-block">
        <div className="auto-panel-skeleton-line" style={{ width: "35%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "95%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "70%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "85%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "60%" }} />
      </div>
      <div className="auto-panel-skeleton-block">
        <div className="auto-panel-skeleton-line" style={{ width: "40%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "90%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "78%" }} />
      </div>
      <div className="auto-panel-skeleton-block">
        <div className="auto-panel-skeleton-line" style={{ width: "50%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "88%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "82%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "65%" }} />
      </div>
      <div className="auto-panel-skeleton-block">
        <div className="auto-panel-skeleton-line" style={{ width: "38%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "93%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "75%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "85%" }} />
        <div className="auto-panel-skeleton-line" style={{ width: "55%" }} />
      </div>
    </div>
  );
}

export function AutoPanel({ windowText, windowTitle, onClose }: AutoPanelProps) {
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 1);
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 1);
  }, []);

  // Start LLM stream when windowText arrives (non-empty)
  useEffect(() => {
    if (!windowText) return;

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
          content: `You receive text from near the user's cursor on their screen. Be useful like a smart friend glancing over their shoulder.

Do: summarize, explain, give your take, fact-check, suggest a reply, translate, recommend — whatever fits.
Don't: describe the UI, list generic tips, repeat back what they can already see, or pad your response.

Keep it short. 2-4 paragraphs max. No bullet-point dumps unless the content genuinely calls for it.`,
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

  // Update fade edges as content grows
  useEffect(() => {
    updateEdges();
  }, [streamingText, updateEdges]);

  const panelRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const el = panelRef.current;
      if (!el) { onClose(); return; }
      el.classList.add("sliding-out");
      el.addEventListener("animationend", () => onClose(), { once: true });
    },
    [onClose],
  );

  const isLoading = !windowText;

  const scrollCls = [
    "auto-panel-content",
    atTop && "at-top",
    atBottom && "at-bottom",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={panelRef} className="auto-panel">
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

      <div ref={scrollRef} className={scrollCls} onScroll={updateEdges}>
        {isLoading ? (
          <SkeletonLoader />
        ) : error ? (
          <p className="auto-panel-error">{error}</p>
        ) : streamingText ? (
          <Markdown text={streamingText} isAnimating={isStreaming} />
        ) : (
          <div className="auto-panel-text">
            {isStreaming ? <SkeletonLoader /> : "No response."}
          </div>
        )}
      </div>
    </div>
  );
}
