import { maybeHandleCanvasShareUrl } from "@/features/canvas-share/open-shared-canvas";

export function openExternalUrl(url: string): void {
  // A canvas-share link opened inside Stella renders as a native canvas in
  // the workspace panel instead of bouncing out to the system browser.
  if (maybeHandleCanvasShareUrl(url)) {
    return;
  }
  if (window.electronAPI?.system.openExternal) {
    window.electronAPI.system.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
