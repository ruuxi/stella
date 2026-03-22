/**
 * IPC handlers for triggering the WebGL morph transition from the renderer.
 * Used during onboarding to morph between demo previews.
 */

import { BrowserWindow, ipcMain } from "electron";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import type { WindowManager } from "../windows/window-manager.js";

const OVERLAY_READY_TIMEOUT_MS = 500;
const MORPH_DONE_TIMEOUT_MS = 5000;

type MorphHandlersOptions = {
  windowManager: WindowManager;
  getOverlayController: () => OverlayWindowController | null;
};

export const registerMorphHandlers = (options: MorphHandlersOptions) => {
  const captureWindow = async (win: BrowserWindow): Promise<string | null> => {
    try {
      const image = await win.webContents.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  };

  const waitForSignal = (
    channel: "overlay:morphReady" | "overlay:morphDone",
    timeoutMs: number,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const handler = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        ipcMain.removeListener(channel, handler);
        resolve(false);
      }, timeoutMs);
      ipcMain.once(channel, handler);
    });
  };

  /**
   * morph:start — Captures the current window, starts the forward morph ripple,
   * and resolves once the overlay is ready (covering the old state).
   */
  ipcMain.handle("morph:start", async () => {
    const fullWindow = options.windowManager.getFullWindow();
    const overlay = options.getOverlayController();
    if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
      return { ok: false };
    }

    const screenshot = await captureWindow(fullWindow);
    if (!screenshot) {
      return { ok: false };
    }

    const bounds = fullWindow.getBounds();
    const readyPromise = waitForSignal("overlay:morphReady", OVERLAY_READY_TIMEOUT_MS);
    overlay.startMorphForward(screenshot, bounds, fullWindow);
    await readyPromise;

    return { ok: true };
  });

  /**
   * morph:complete — Captures the new window state, crossfades from old to new,
   * and resolves when the morph animation finishes.
   */
  ipcMain.handle("morph:complete", async () => {
    const fullWindow = options.windowManager.getFullWindow();
    const overlay = options.getOverlayController();
    if (!fullWindow || fullWindow.isDestroyed() || !overlay) {
      return { ok: false };
    }

    const screenshot = await captureWindow(fullWindow);
    if (!screenshot) {
      overlay.endMorph();
      return { ok: false };
    }

    const donePromise = waitForSignal("overlay:morphDone", MORPH_DONE_TIMEOUT_MS);
    overlay.startMorphReverse(screenshot, false);
    await donePromise;
    overlay.endMorph();

    return { ok: true };
  });
};
