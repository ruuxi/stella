import { ipcMain, type BrowserWindow } from "electron";

type MorphSignalChannel = "overlay:morphReady" | "overlay:morphDone";

export async function captureWindowDataUrl(
  win: BrowserWindow,
  onResult?: (ok: boolean, durationMs: number) => void,
): Promise<string | null> {
  const startedAt = performance.now();
  try {
    const image = await win.webContents.capturePage();
    onResult?.(true, Math.round(performance.now() - startedAt));
    return image.toDataURL();
  } catch {
    onResult?.(false, Math.round(performance.now() - startedAt));
    return null;
  }
}

export function waitForOverlayMorphSignal(
  channel: MorphSignalChannel,
  transitionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const handler = (_event: unknown, payload?: { transitionId?: string }) => {
      if (payload?.transitionId !== transitionId) {
        return;
      }
      clearTimeout(timer);
      ipcMain.removeListener(channel, handler);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      resolve(false);
    }, timeoutMs);
    ipcMain.on(channel, handler);
  });
}
