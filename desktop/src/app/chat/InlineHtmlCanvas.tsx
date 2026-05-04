/**
 * Inline canvas renderer for the orchestrator's `Display` tool.
 *
 * The Display tool emits HTML / SVG fragments that used to land in a
 * dedicated tab in the workspace panel. They now render directly under
 * the assistant message that produced them, so the canvas stays in the
 * conversation flow rather than racing the chat for the user's
 * attention.
 *
 * Real-DOM (no iframe) so the model's content streams in via morphdom
 * DOM-diffing — exactly the contract the Display guidelines target
 * (`<style>` → content → `<script>`, prefer flat fills, content
 * appears progressively without flashing). The container has no fixed
 * height; it grows to whatever the in-flow content needs.
 *
 * While a Display call is in flight the renderer pulls partials off
 * the singleton `liveDisplayStream`; once the persisted tool call
 * lands the row's `html` prop becomes the source of truth.
 */

import { useEffect, useRef } from "react";
import { applyMorphdomHtml } from "@/shell/apply-morphdom-html";
import { useLiveDisplayStream } from "@/app/chat/live-display-stream";
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
  const { html: liveHtml } = useLiveDisplayStream();

  // Prefer the longer of (live stream, persisted prop). Live stream
  // wins mid-flight (it's strictly ahead of what's been persisted to
  // SQLite); the persisted prop wins after the run finishes (the live
  // stream gets reset back to empty, or stays stale from a prior turn
  // — either way, fall back to props).
  const effective = liveHtml.length > html.length ? liveHtml : html;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!effective) {
      container.replaceChildren();
      return;
    }
    applyMorphdomHtml(container, "canvas-display", effective, {
      executeScripts: true,
    });
  }, [effective]);

  return (
    <div
      ref={containerRef}
      className="inline-html-canvas canvas-display"
      onClick={handleCanvasClick}
    />
  );
};
