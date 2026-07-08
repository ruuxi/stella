/**
 * Renderer entry point for opening a shared canvas URL as a native canvas.
 *
 * When a `<CANVAS_SHARE_BASE_URL>/c/<slug>` link is opened inside Stella
 * (pasted, clicked, or routed from a deep link), we ask the main process to
 * fetch the remote HTML and materialize it into the same
 * `~/.stella/outputs/html/` store local canvases use, then render it through
 * the identical sandboxed canvas path — no extra privileges. The network +
 * filesystem work runs in main (privileged, and free of renderer CORS), and
 * the renderer only routes the resulting file-backed payload.
 */
import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "@/shared/contracts/display-payload";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { canvasShareBaseUrl, isCanvasShareUrl } from "@/shared/lib/canvas-share";

/** Whether `url` matches the configured canvas-share pattern. */
export const isRendererCanvasShareUrl = (url: string): boolean =>
  isCanvasShareUrl(url, canvasShareBaseUrl());

/**
 * Fetch + render a shared canvas natively. Returns `true` when the URL was a
 * recognized canvas-share link that was handled (so the caller should NOT
 * fall back to opening it in the system browser), `false` otherwise.
 */
export const renderSharedCanvasFromUrl = async (
  url: string,
): Promise<boolean> => {
  if (!isRendererCanvasShareUrl(url)) return false;
  const openSharedCanvas = window.electronAPI?.display?.openSharedCanvas;
  if (typeof openSharedCanvas !== "function") return false;

  let raw: unknown;
  try {
    raw = await openSharedCanvas({ url });
  } catch {
    return false;
  }

  const payload: DisplayTabPayload | null = normalizeDisplayPayload(raw);
  if (!payload || payload.kind !== "canvas-html") return false;
  openDisplayPayloadTab(payload, { activate: true });
  return true;
};

/**
 * Fire-and-forget guard for synchronous callers (e.g. the external-link
 * helper). Returns `true` immediately when the URL is a canvas-share link
 * (kicking off the async native render), so the caller can skip the browser.
 */
export const maybeHandleCanvasShareUrl = (url: string): boolean => {
  if (!isRendererCanvasShareUrl(url)) return false;
  void renderSharedCanvasFromUrl(url);
  return true;
};
