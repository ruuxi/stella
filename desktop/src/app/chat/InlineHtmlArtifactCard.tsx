/**
 * Inline HTML canvas artifact card.
 *
 * Replaces the older `InlineHtmlCanvas` (which dumped real HTML into the
 * chat document with morphdom). HTML now lives as a file under
 * `state/outputs/html/<slug>.html` and renders in the workspace panel's
 * Canvas tab; this card is the chat-side affordance — same shape as the
 * inline image card, with a small live preview the user can click to open
 * the canvas full-size in the panel.
 *
 * The live preview iframe lazy-mounts via `useHasBeenVisible` so a chat
 * with many canvas turns doesn't run all of their scripts at once when
 * the timeline first paints.
 */

import { useCallback, useRef } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import { useHasBeenVisible } from "@/shared/hooks/use-has-been-visible";
import "./inline-html-artifact-card.css";

type InlineHtmlArtifactPayload = Extract<DisplayPayload, { kind: "canvas-html" }>;

const decoder = new TextDecoder("utf-8");

const InlineHtmlPreview = ({
  payload,
  title,
}: {
  payload: InlineHtmlArtifactPayload;
  title: string;
}) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    payload.filePath,
    "Canvas preview requires the Stella desktop app.",
  );
  const html = bytes ? decoder.decode(bytes) : "";

  if (error) {
    return (
      <span className="inline-html-artifact-card__placeholder">
        Couldn't load canvas
      </span>
    );
  }
  if (!html) {
    return (
      <span className="inline-html-artifact-card__placeholder">
        {loading ? "Preparing canvas…" : "Canvas"}
      </span>
    );
  }
  return (
    <iframe
      // Stable iframe per (path, createdAt) so iterating on the same
      // slug refreshes without a flash.
      key={`${payload.filePath}:${payload.createdAt}`}
      title={title}
      className="inline-html-artifact-card__iframe"
      srcDoc={html}
      sandbox="allow-scripts allow-popups allow-modals allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  );
};

export const InlineHtmlArtifactCard = ({
  payload,
}: {
  payload: InlineHtmlArtifactPayload;
}) => {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  // Wait until the card is actually within (or near) the viewport
  // before reading the HTML and instantiating the sandboxed iframe.
  // Long chats with many canvas turns no longer pay the parse +
  // script-execute cost for offscreen rows.
  const visible = useHasBeenVisible(frameRef);

  const handleOpen = useCallback(() => {
    displayTabs.openTab(payloadToTabSpec(payload));
  }, [payload]);

  const title = payload.title ?? "Canvas";

  return (
    <button
      type="button"
      className="inline-html-artifact-card"
      onClick={handleOpen}
      title="Open in canvas"
    >
      <span
        ref={frameRef}
        className="inline-html-artifact-card__frame"
        aria-hidden
      >
        {visible ? (
          <InlineHtmlPreview payload={payload} title={title} />
        ) : (
          <span className="inline-html-artifact-card__placeholder">
            Canvas
          </span>
        )}
        <span className="inline-html-artifact-card__shade" aria-hidden />
      </span>
      <span className="inline-html-artifact-card__meta">
        <span className="inline-html-artifact-card__title">{title}</span>
        <span className="inline-html-artifact-card__hint">Open canvas</span>
      </span>
    </button>
  );
};
