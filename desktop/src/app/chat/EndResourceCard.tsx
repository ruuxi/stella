/**
 * Per-turn "end-resource" pill rendered after the assistant content.
 *
 * Matches Codex's `wde` component: a clickable badge that points at the
 * primary file the agent edited, generated, or read in the turn. Click
 * opens (or re-activates) the matching tab in the workspace panel via
 * the singleton `displayTabs` store.
 */

import { useCallback, useMemo } from "react";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { getDisplayPayloadTitle } from "@/shared/contracts/display-payload";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import { DisplayTabIcon } from "@/shell/display/icons";
import { basenameOf } from "@/shell/display/path-to-viewer";
import "./end-resource-card.css";

const labelForPayload = (payload: DisplayPayload): string => {
  switch (payload.kind) {
    case "html":
      return getDisplayPayloadTitle(payload);
    case "office":
      return basenameOf(payload.previewRef.sourcePath);
    case "markdown":
    case "source-diff":
      return basenameOf(payload.filePath);
    case "file-artifact":
      return basenameOf(payload.filePath);
    case "pdf":
      return basenameOf(payload.filePath);
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths.length === 1
            ? basenameOf(payload.asset.filePaths[0]!)
            : `${payload.asset.filePaths.length} images`;
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return basenameOf(payload.asset.filePath);
        case "text":
          return getDisplayPayloadTitle(payload);
      }
  }
};

const tooltipForPayload = (payload: DisplayPayload): string | undefined => {
  switch (payload.kind) {
    case "office":
      return payload.previewRef.sourcePath;
    case "markdown":
    case "source-diff":
      return payload.filePath;
    case "file-artifact":
      return payload.filePath;
    case "pdf":
      return payload.filePath;
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths.join("\n");
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return payload.asset.filePath;
        default:
          return undefined;
      }
    default:
      return undefined;
  }
};

export const EndResourceCard = ({ payload }: { payload: DisplayPayload }) => {
  const spec = useMemo(() => payloadToTabSpec(payload), [payload]);
  const label = labelForPayload(payload);
  const tooltip = tooltipForPayload(payload);

  const handleClick = useCallback(() => {
    // Re-build on click rather than reusing the memoized spec — this
    // ensures the captured `payload` props (especially media asset
    // contents) are always the freshest copy. payloadToTabSpec is cheap.
    displayTabs.openTab(payloadToTabSpec(payload));
  }, [payload]);

  return (
    <button
      type="button"
      className="end-resource-card"
      onClick={handleClick}
      title={tooltip}
    >
      <span className="end-resource-card__icon">
        <DisplayTabIcon kind={spec.kind} size={26} />
      </span>
      <span className="end-resource-card__text">
        <span className="end-resource-card__label">{label}</span>
        <span className="end-resource-card__action" aria-hidden>
          Open in panel
        </span>
      </span>
    </button>
  );
};
