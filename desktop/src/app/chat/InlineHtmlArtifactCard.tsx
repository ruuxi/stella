/**
 * Inline HTML canvas artifact card.
 *
 * Replaces the older `InlineHtmlCanvas` (which dumped real HTML into the
 * chat document with morphdom). HTML now lives as a file under
 * `state/outputs/html/<slug>.html` and renders in the workspace panel's
 * Canvas tab; this card is the chat-side affordance — same shape as the
 * inline image card, with a small live preview the user can click to open
 * the canvas full-size in the panel.
 */

import { useCallback } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import { useDisplayFileBytes } from "@/shared/hooks/use-display-file-data";
import "./inline-html-artifact-card.css";

type InlineHtmlArtifactPayload = Extract<DisplayPayload, { kind: "canvas-html" }>;

const decoder = new TextDecoder("utf-8");

export const InlineHtmlArtifactCard = ({
  payload,
}: {
  payload: InlineHtmlArtifactPayload;
}) => {
  const { bytes, error, loading } = useDisplayFileBytes(
    payload.filePath,
    "Canvas preview requires the Stella desktop app.",
  );
  const html = bytes ? decoder.decode(bytes) : "";

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
      <span className="inline-html-artifact-card__frame" aria-hidden>
        {error ? (
          <span className="inline-html-artifact-card__placeholder">
            Couldn't load canvas
          </span>
        ) : html ? (
          <iframe
            // Using a stable iframe per (path, createdAt) so iterating
            // on the same slug refreshes without a flash.
            key={`${payload.filePath}:${payload.createdAt}`}
            title={title}
            className="inline-html-artifact-card__iframe"
            srcDoc={html}
            sandbox="allow-scripts allow-popups allow-modals allow-forms"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="inline-html-artifact-card__placeholder">
            {loading ? "Preparing canvas…" : "Canvas"}
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
