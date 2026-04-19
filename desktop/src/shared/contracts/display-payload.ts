import type { OfficePreviewRef } from "./office-preview";
import { isOfficePreviewRef } from "./office-preview";

/**
 * Tagged union for everything the Display sidebar can show.
 *
 * - `html`   — freeform HTML produced by the agent's `Display` tool.
 *              Morphdom-applied into the sidebar (existing behavior).
 * - `office` — docx/xlsx/pptx live-preview produced by `stella-office preview`.
 *              Renders the existing OfficePreviewCard (iframe + auto-refresh).
 * - `pdf`    — local PDF file rendered with react-pdf in the renderer.
 *
 * The IPC channel `display:update` carries either a raw HTML `string`
 * (legacy compatibility for the runtime worker's existing `displayHtml(html)`
 * call) or a structured `DisplayPayload` object.
 */
export type DisplayPayload =
  | { kind: "html"; html: string }
  | { kind: "office"; previewRef: OfficePreviewRef; title?: string }
  | { kind: "pdf"; filePath: string; title?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

export const isDisplayPayload = (value: unknown): value is DisplayPayload => {
  if (!isRecord(value)) return false;
  if (value.kind === "html") {
    return typeof value.html === "string";
  }
  if (value.kind === "office") {
    return isOfficePreviewRef((value as { previewRef?: unknown }).previewRef);
  }
  if (value.kind === "pdf") {
    return typeof (value as { filePath?: unknown }).filePath === "string";
  }
  return false;
};

/**
 * Normalize legacy `string` payloads (raw HTML pushed by the agent's
 * `Display` tool) into the tagged union shape. Returns `null` when the
 * input is neither a string nor a recognized payload.
 */
export const normalizeDisplayPayload = (
  value: unknown,
): DisplayPayload | null => {
  if (typeof value === "string") {
    return value.trim().length > 0 ? { kind: "html", html: value } : null;
  }
  return isDisplayPayload(value) ? value : null;
};

/** Quick title helper for the sidebar header / external open. */
export const getDisplayPayloadTitle = (payload: DisplayPayload): string => {
  if (payload.kind === "html") return "Display";
  if (payload.kind === "office") {
    return payload.title ?? payload.previewRef.title;
  }
  return payload.title ?? payload.filePath.split("/").pop() ?? "Document";
};
