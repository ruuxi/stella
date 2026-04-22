import { useCallback, useEffect, useRef, useState } from "react";

interface UserMessageBodyProps {
  text: string;
}

/**
 * Renders a user message bubble's text body with collapse/expand for long
 * messages.
 *
 * The visible text is clamped via CSS (`-webkit-line-clamp`) using a per-
 * surface line count exposed as `--user-message-clamp-lines`. Overflow is
 * detected by comparing scrollHeight to clientHeight while collapsed, and a
 * "Show more" / "Show less" toggle is rendered only when truncation actually
 * occurs at the current width.
 */
export function UserMessageBody({ text }: UserMessageBodyProps) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;

    const measure = () => {
      const overflows = el.scrollHeight - el.clientHeight > 1;
      setIsOverflowing((prev) => (prev === overflows ? prev : overflows));
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const showToggle = isOverflowing || expanded;

  return (
    <div className="event-user-body" data-expanded={expanded}>
      <div ref={bodyRef} className="event-body">
        {text}
      </div>
      {showToggle && (
        <button
          type="button"
          className="event-user-toggle"
          onClick={toggle}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
