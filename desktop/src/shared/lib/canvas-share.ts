/**
 * Renderer-facing view of the shared canvas-share grammar. Re-exports the
 * electron-free helpers from `runtime/contracts/canvas-share` and resolves the
 * configured public base URL from build-time env.
 *
 * The final share domain is TBD/pending, so the base URL is read from config
 * (`VITE_CANVAS_SHARE_BASE_URL`) and returns `null` when unset — callers show a
 * "domain pending" affordance rather than pointing at a guessed host.
 */
import {
  buildCanvasShareUrl,
  canvasSharePathForSlug,
  CANVAS_SHARE_PATH_PREFIX,
  isCanvasShareSlug,
  isCanvasShareUrl,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
} from "../../../../runtime/contracts/canvas-share.js";

export {
  buildCanvasShareUrl,
  canvasSharePathForSlug,
  CANVAS_SHARE_PATH_PREFIX,
  isCanvasShareSlug,
  isCanvasShareUrl,
  parseCanvasShareSlug,
  readCanvasShareBaseUrl,
};

/**
 * Configured public base URL for shared canvases, or `null` when the domain
 * has not been provisioned yet. Sourced from `VITE_CANVAS_SHARE_BASE_URL`.
 */
export const canvasShareBaseUrl = (): string | null =>
  readCanvasShareBaseUrl(
    import.meta.env.VITE_CANVAS_SHARE_BASE_URL as string | undefined,
  );
