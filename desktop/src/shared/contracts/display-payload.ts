import type { OfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";
import { isOfficePreviewRef } from "../../../../runtime/contracts/office-preview.js";

export type DisplayFileArtifactKind =
  | "office-document"
  | "office-spreadsheet"
  | "office-slides"
  | "delimited-table";

/**
 * Tagged union for resources Stella can surface in chat or the workspace panel.
 *
 * - `html`   — freeform HTML. Rendered inline in chat.
 * - `office` — docx/xlsx/pptx live-preview produced by `stella-office preview`.
 *              Renders the existing OfficePreviewCard (iframe + auto-refresh).
 * - `markdown` — local Markdown / MDX files rendered in the panel.
 * - `source-diff` — developer-gated code-file change preview.
 * - `file-artifact` — a previewable local file without an existing live
 *              preview ref. The sidebar resolves it into the right viewer.
 * - `pdf`    — local PDF file rendered with react-pdf in the renderer.
 * - `media`  — generated media (image/video/audio/3d/text) materialized to
 *              `state/media/outputs/`. Emitted by the media materializer when
 *              any media job for the current owner succeeds.
 * - `trash`  — Stella's deferred-delete trash. The actual UI is intentionally
 *              owned by the future tab implementation; this payload wires the
 *              display tab, list, and force-delete contracts.
 *
 * The IPC channel `display:update` carries structured, tab-compatible
 * `DisplayPayload` objects.
 */
export type DisplayPayload =
  | { kind: "html"; html: string; title?: string; createdAt?: number }
  | {
      /**
       * Live URL preview (e.g., per-social-session Vite dev server).
       * Rendered as an iframe in its own dedicated tab.
       */
      kind: "url";
      url: string;
      title: string;
      tabId: string;
      tooltip?: string;
    }
  | { kind: "office"; previewRef: OfficePreviewRef; title?: string }
  | {
      kind: "markdown";
      filePath: string;
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "source-diff";
      filePath: string;
      title?: string;
      patch?: string;
      createdAt?: number;
    }
  | {
      kind: "file-artifact";
      filePath: string;
      artifactKind: DisplayFileArtifactKind;
      title?: string;
      createdAt?: number;
    }
  | { kind: "pdf"; filePath: string; title?: string }
  | {
      kind: "trash";
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "media";
      asset: MediaAsset;
      jobId?: string;
      capability?: string;
      prompt?: string;
      aspectRatio?: string;
      requestedSize?: { width: number; height: number };
      presentation?: "inline-image";
      createdAt: number;
    };

export type DisplayTabPayload = Exclude<DisplayPayload, { kind: "html" }>;

/**
 * What was generated. Mirrors the shape of `OutputMedia` in
 * `desktop/src/app/media/media-store.ts` but uses local file paths instead of
 * remote URLs so we don't depend on time-bounded provider URLs at view time.
 */
export type MediaAsset =
  | { kind: "image"; filePaths: string[] }
  | { kind: "video"; filePath: string }
  | { kind: "audio"; filePath: string }
  | { kind: "model3d"; filePath: string; label?: string }
  | { kind: "download"; filePath: string; label: string }
  | { kind: "text"; text: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

const isMediaAsset = (value: unknown): value is MediaAsset => {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "image":
      return (
        Array.isArray((value as { filePaths?: unknown }).filePaths) &&
        (value as { filePaths: unknown[] }).filePaths.every(
          (p) => typeof p === "string",
        )
      );
    case "video":
    case "audio":
      return typeof (value as { filePath?: unknown }).filePath === "string";
    case "model3d":
    case "download":
      return typeof (value as { filePath?: unknown }).filePath === "string";
    case "text":
      return typeof (value as { text?: unknown }).text === "string";
    default:
      return false;
  }
};

export const isDisplayPayload = (value: unknown): value is DisplayPayload => {
  if (!isRecord(value)) return false;
  if (value.kind === "html") {
    const createdAt = (value as { createdAt?: unknown }).createdAt;
    return (
      typeof value.html === "string" &&
      ((value as { title?: unknown }).title === undefined ||
        typeof (value as { title?: unknown }).title === "string") &&
      (createdAt === undefined ||
        (typeof createdAt === "number" && Number.isFinite(createdAt)))
    );
  }
  if (value.kind === "url") {
    return (
      typeof (value as { url?: unknown }).url === "string" &&
      typeof (value as { title?: unknown }).title === "string" &&
      typeof (value as { tabId?: unknown }).tabId === "string"
    );
  }
  if (value.kind === "office") {
    return isOfficePreviewRef((value as { previewRef?: unknown }).previewRef);
  }
  if (value.kind === "markdown" || value.kind === "source-diff") {
    const createdAt = (value as { createdAt?: unknown }).createdAt;
    return (
      typeof (value as { filePath?: unknown }).filePath === "string" &&
      ((value as { title?: unknown }).title === undefined ||
        typeof (value as { title?: unknown }).title === "string") &&
      ((value as { patch?: unknown }).patch === undefined ||
        typeof (value as { patch?: unknown }).patch === "string") &&
      (createdAt === undefined ||
        (typeof createdAt === "number" && Number.isFinite(createdAt)))
    );
  }
  if (value.kind === "file-artifact") {
    const artifactKind = (value as { artifactKind?: unknown }).artifactKind;
    const createdAt = (value as { createdAt?: unknown }).createdAt;
    return (
      typeof (value as { filePath?: unknown }).filePath === "string" &&
      (createdAt === undefined ||
        (typeof createdAt === "number" && Number.isFinite(createdAt))) &&
      (artifactKind === "office-document" ||
        artifactKind === "office-spreadsheet" ||
        artifactKind === "office-slides" ||
        artifactKind === "delimited-table")
    );
  }
  if (value.kind === "pdf") {
    return typeof (value as { filePath?: unknown }).filePath === "string";
  }
  if (value.kind === "trash") {
    const createdAt = (value as { createdAt?: unknown }).createdAt;
    return (
      ((value as { title?: unknown }).title === undefined ||
        typeof (value as { title?: unknown }).title === "string") &&
      (createdAt === undefined ||
        (typeof createdAt === "number" && Number.isFinite(createdAt)))
    );
  }
  if (value.kind === "media") {
    return (
      isMediaAsset((value as { asset?: unknown }).asset) &&
      typeof (value as { createdAt?: unknown }).createdAt === "number"
    );
  }
  return false;
};

export const isDisplayTabPayload = (
  value: unknown,
): value is DisplayTabPayload =>
  isDisplayPayload(value) && value.kind !== "html";

/**
 * Validate payloads accepted by the workspace panel's display channel.
 * HTML resources render inline in chat and are intentionally excluded here.
 */
export const normalizeDisplayPayload = (
  value: unknown,
): DisplayTabPayload | null => (isDisplayTabPayload(value) ? value : null);

/** Quick title helper for the sidebar header / external open. */
export const getDisplayPayloadTitle = (payload: DisplayPayload): string => {
  if (payload.kind === "html") return payload.title ?? "Canvas";
  if (payload.kind === "url") return payload.title;
  if (payload.kind === "office") {
    return payload.title ?? payload.previewRef.title;
  }
  if (payload.kind === "markdown" || payload.kind === "source-diff") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "File";
  }
  if (payload.kind === "file-artifact") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "File";
  }
  if (payload.kind === "pdf") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "Document";
  }
  if (payload.kind === "trash") {
    return payload.title ?? "Trash";
  }
  // payload.kind === "media"
  if (payload.prompt) return payload.prompt;
  if (payload.capability) return payload.capability.replace(/_/g, " ");
  switch (payload.asset.kind) {
    case "image":
      return payload.asset.filePaths.length > 1
        ? "Generated images"
        : "Generated image";
    case "video":
      return "Generated video";
    case "audio":
      return "Generated audio";
    case "model3d":
      return payload.asset.label ?? "Generated 3D model";
    case "download":
      return payload.asset.label;
    case "text":
      return "Generated text";
  }
};
