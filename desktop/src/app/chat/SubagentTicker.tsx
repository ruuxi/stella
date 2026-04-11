import { useRef, useLayoutEffect } from "react";
import "./indicators.css";

type SubagentTickerProps = {
  text: string;
};

export function SubagentTicker({ text }: SubagentTickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const span = spanRef.current;
    if (!container || !span) return;

    const containerW = container.clientWidth;
    const textW = span.scrollWidth;
    const offset = Math.min(0, containerW - textW);
    span.style.transform = `translateX(${offset}px)`;
  });

  if (!text) return null;

  return (
    <div ref={containerRef} className="subagent-ticker" aria-live="polite">
      <span ref={spanRef} className="subagent-ticker__text">
        {text}
      </span>
    </div>
  );
}
