/**
 * Per-turn "end-resource" pill rendered after the assistant content.
 *
 * Matches Codex's `wde` component: a clickable badge that points at the
 * primary file the agent edited, generated, or read in the turn. Click
 * opens (or re-activates) the matching tab in the workspace panel via
 * the singleton `displayTabs` store.
 */

import { useCallback, useMemo } from "react";
import type {
  DisplayPayload,
  DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { getDisplayPayloadTitle } from "@/shared/contracts/display-payload";
import { displayTabs } from "@/shell/display/tab-store";
import {
  createSourceDiffTabSpec,
  displayTabKindForPayload,
  payloadToTabSpec,
} from "@/shell/display/payload-to-tab-spec";
import { pushAndOpenSourceDiffBatch } from "@/shell/display/source-diff-batches";
import { DisplayTabIcon } from "@/shell/display/icons";
import {
  basenameOf,
  extensionOf,
  isDeveloperResourceExtension,
} from "@/shell/display/path-to-viewer";
import { OpenWithMenu } from "./OpenWithMenu";
import "./end-resource-card.css";

/**
 * Subtitle for an artifact card formatted as "Category · FORMAT".
 *
 * Mirrors the way macOS Finder describes a file (kind + uppercase
 * extension). The "Category" half comes from the `DisplayPayload`
 * kind, the "FORMAT" half from the actual file extension.
 */
const categoryAndFormatForPayload = (
  payload: DisplayPayload,
): { category: string; format: string | null } => {
  const fmtFromPath = (filePath: string): string | null => {
    const ext = extensionOf(filePath);
    return ext ? ext.toUpperCase() : null;
  };
  switch (payload.kind) {
    case "pdf":
      return { category: "PDF", format: fmtFromPath(payload.filePath) };
    case "markdown":
      return { category: "Document", format: fmtFromPath(payload.filePath) };
    case "source-diff":
      return { category: "Code", format: fmtFromPath(payload.filePath) };
    case "office": {
      const ext = extensionOf(payload.previewRef.sourcePath);
      const format = ext ? ext.toUpperCase() : null;
      if (ext === "doc" || ext === "docx") {
        return { category: "Document", format };
      }
      if (ext === "xls" || ext === "xlsx" || ext === "xlsm") {
        return { category: "Spreadsheet", format };
      }
      if (ext === "ppt" || ext === "pptx") {
        return { category: "Slides", format };
      }
      return { category: "Document", format };
    }
    case "file-artifact":
      switch (payload.artifactKind) {
        case "office-document":
          return { category: "Document", format: fmtFromPath(payload.filePath) };
        case "office-spreadsheet":
          return {
            category: "Spreadsheet",
            format: fmtFromPath(payload.filePath),
          };
        case "office-slides":
          return { category: "Slides", format: fmtFromPath(payload.filePath) };
        case "delimited-table":
          return { category: "Table", format: fmtFromPath(payload.filePath) };
      }
      if (isDeveloperResourceExtension(extensionOf(payload.filePath))) {
        return { category: "Code", format: fmtFromPath(payload.filePath) };
      }
      return { category: "File", format: fmtFromPath(payload.filePath) };
    case "media": {
      switch (payload.asset.kind) {
        case "image": {
          const first = payload.asset.filePaths[0];
          return {
            category: "Image",
            format: first ? fmtFromPath(first) : null,
          };
        }
        case "video":
          return { category: "Video", format: fmtFromPath(payload.asset.filePath) };
        case "audio":
          return { category: "Audio", format: fmtFromPath(payload.asset.filePath) };
        case "model3d":
          return {
            category: "3D Model",
            format: fmtFromPath(payload.asset.filePath),
          };
        case "download":
          return { category: "File", format: fmtFromPath(payload.asset.filePath) };
        case "text":
          return { category: "Text", format: null };
      }
      return { category: "Media", format: null };
    }
    case "canvas-html":
      return { category: "Canvas", format: "HTML" };
    case "url":
      return { category: "Link", format: null };
    case "trash":
      return { category: "Trash", format: null };
  }
};

/**
 * Returns the first on-disk file path the payload references, or null
 * when the payload has no real file (URLs, trash bins, text-only media).
 * The "Open with…" drop-up only appears when a path is available — there
 * is nothing external to open otherwise.
 */
const localFilePathForPayload = (payload: DisplayPayload): string | null => {
  switch (payload.kind) {
    case "office":
      return payload.previewRef.sourcePath;
    case "markdown":
    case "source-diff":
    case "file-artifact":
    case "pdf":
      return payload.filePath;
    case "canvas-html":
      return payload.filePath;
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths[0] ?? null;
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return payload.asset.filePath;
        default:
          return null;
      }
    default:
      return null;
  }
};

const labelForPayload = (payload: DisplayPayload): string => {
  switch (payload.kind) {
    case "canvas-html":
      return getDisplayPayloadTitle(payload);
    case "url":
      return payload.title;
    case "office":
      return basenameOf(payload.previewRef.sourcePath);
    case "markdown":
    case "source-diff":
      return basenameOf(payload.filePath);
    case "file-artifact":
      return basenameOf(payload.filePath);
    case "pdf":
      return basenameOf(payload.filePath);
    case "trash":
      return getDisplayPayloadTitle(payload);
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
    case "url":
      return payload.tooltip ?? payload.url;
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

export const EndResourceCard = ({ payload }: { payload: DisplayTabPayload }) => {
  const kind = displayTabKindForPayload(payload);
  const label = labelForPayload(payload);
  const tooltip = tooltipForPayload(payload);

  const handleClick = useCallback(() => {
    // Build the spec on click only — `payloadToTabSpec` is the path
    // that registers media/canvas items into shared stores, so we
    // defer it to the moment the user actually opens the tab.
    displayTabs.openTab(payloadToTabSpec(payload));
  }, [payload]);

  // Source-diff payloads must always flow through `SourceDiffEndResource`
  // so the batches store is populated before the singleton tab is opened.
  // Routing them through `EndResourceCard` would open an empty / stale
  // "Code changes" tab. Guard placed after hooks so React's hook order
  // stays stable across renders.
  if (payload.kind === "source-diff") return null;

  const localFilePath = localFilePathForPayload(payload);
  const { category, format } = categoryAndFormatForPayload(payload);
  const subtitle = format ? `${category} · ${format}` : category;

  return (
    <div className="end-resource-card" title={tooltip}>
      <button
        type="button"
        className="end-resource-card__main"
        onClick={handleClick}
      >
        <span className="end-resource-card__icon">
          <DisplayTabIcon kind={kind} size={26} />
        </span>
        <span className="end-resource-card__text">
          <span className="end-resource-card__label">{label}</span>
          <span className="end-resource-card__subtitle" aria-hidden>
            <span className="end-resource-card__subtitle-default">
              {subtitle}
            </span>
            <span className="end-resource-card__subtitle-hover">
              Open preview
            </span>
          </span>
        </span>
      </button>
      {localFilePath && <OpenWithMenu filePath={localFilePath} />}
    </div>
  );
};

/**
 * Inline + card surface for per-turn developer file changes.
 *
 * - `batchId` keys the source-diff batch (use the assistant row's
 *   stable id so re-renders of the same turn replace the batch in
 *   place instead of stacking duplicates in the footer).
 * - When `payloads.length === 1`, renders as a quiet underlined
 *   filename.
 * - When `payloads.length > 1`, renders as the artifact card
 *   labeled "N file changes".
 * Either path pushes the batch into the source-diff store and
 * opens (or activates) the singleton "Code changes" tab.
 */
export const SourceDiffEndResource = ({
  batchId,
  payloads,
}: {
  batchId: string;
  payloads: DisplayPayload[];
}) => {
  const sourceDiffPayloads = useMemo(
    () => payloads.filter((entry) => entry.kind === "source-diff"),
    [payloads],
  );
  const isMulti = sourceDiffPayloads.length > 1;
  const primary = sourceDiffPayloads[0];
  const createdAt = useMemo(() => {
    const latest = sourceDiffPayloads.reduce(
      (max, entry) =>
        entry.kind === "source-diff" && (entry.createdAt ?? 0) > max
          ? (entry.createdAt ?? 0)
          : max,
      0,
    );
    return latest > 0 ? latest : Date.now();
  }, [sourceDiffPayloads]);

  const handleClick = useCallback(() => {
    if (sourceDiffPayloads.length === 0) return;
    pushAndOpenSourceDiffBatch(
      {
        id: batchId,
        createdAt,
        payloads: sourceDiffPayloads,
      },
      createSourceDiffTabSpec(),
    );
  }, [batchId, createdAt, sourceDiffPayloads]);

  if (!primary) return null;

  if (!isMulti) {
    const tooltip =
      primary.kind === "source-diff" ? primary.filePath : undefined;
    const label = labelForPayload(primary);
    return (
      <button
        type="button"
        className="end-resource-link"
        onClick={handleClick}
        title={tooltip}
      >
        <span className="end-resource-link__label">{label}</span>
      </button>
    );
  }

  const kind = displayTabKindForPayload(primary);
  return (
    <button
      type="button"
      className="end-resource-card"
      onClick={handleClick}
      title={sourceDiffPayloads
        .map((entry) =>
          entry.kind === "source-diff" ? entry.filePath : "",
        )
        .filter(Boolean)
        .join("\n")}
    >
      <span className="end-resource-card__icon">
        <DisplayTabIcon kind={kind} size={26} />
      </span>
      <span className="end-resource-card__text">
        <span className="end-resource-card__label">
          {sourceDiffPayloads.length} file changes
        </span>
        <span className="end-resource-card__action" aria-hidden>
          Open in panel
        </span>
      </span>
    </button>
  );
};
