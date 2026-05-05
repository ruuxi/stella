/**
 * Inline canvas renderer for HTML / SVG artifacts.
 *
 * Real-DOM (no iframe) so HTML artifacts can run their own scripts. The
 * container has no fixed height; it grows to whatever the in-flow content
 * needs.
 */

import { useEffect, useRef } from "react";
import { applyMorphdomHtml } from "@/shell/apply-morphdom-html";
import "./inline-html-canvas.css";

/**
 * Click bridge for buttons that ask the chat to send a follow-up
 * message. Models drop `<button data-action="send-message"
 * data-prompt="…">` elements; one delegated listener turns them into
 * the `stella:send-message` window event the composer already
 * understands.
 */
const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>) => {
  const target = event.target as Element | null;
  const trigger = target?.closest?.('[data-action="send-message"]');
  if (!trigger) return;
  const prompt = trigger.getAttribute("data-prompt");
  if (!prompt) return;
  window.dispatchEvent(
    new CustomEvent("stella:send-message", { detail: { text: prompt } }),
  );
};

export const InlineHtmlCanvas = ({ html }: { html: string }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!html) {
      container.replaceChildren();
      return;
    }
    applyMorphdomHtml(container, "canvas-display", html, {
      executeScripts: true,
    });
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="inline-html-canvas canvas-display"
      onClick={handleCanvasClick}
    />
  );
};
