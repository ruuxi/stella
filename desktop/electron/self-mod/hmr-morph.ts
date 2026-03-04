/**
 * Orchestrates the liquid morph transition during HMR resume.
 *
 * Flow:
 * 1. Capture old page state → tell overlay to start morph
 * 2. Resume HMR behind the morph canvas (overlay covers main window)
 * 3. Wait for load to settle → capture new state
 * 4. Immediately tell overlay to reverse with new screenshot (no pause)
 * 5. Wait for overlay to signal completion → cleanup
 */

import { ipcMain, type BrowserWindow } from "electron";
import type { OverlayWindowController } from "../windows/overlay-window.js";

const FORWARD_ANIM_MS = 800;
const CAPTURE_SETTLE_DELAY_MS = 150;
const MORPH_DONE_TIMEOUT_MS = 5000;

export type HmrMorphOrchestrator = {
  runTransition: (opts: {
    resumeHmr: () => Promise<void>;
  }) => Promise<void>;
};

export function createHmrMorphOrchestrator(deps: {
  getFullWindow: () => BrowserWindow | null;
  getOverlayController: () => OverlayWindowController | null;
}): HmrMorphOrchestrator {

  const captureWindow = async (win: BrowserWindow): Promise<string | null> => {
    try {
      const image = await win.webContents.capturePage();
      return image.toDataURL();
    } catch {
      return null;
    }
  };

  const waitForMorphDone = (): Promise<void> => {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ipcMain.removeAllListeners("overlay:morphDone");
        resolve();
      }, MORPH_DONE_TIMEOUT_MS);

      ipcMain.once("overlay:morphDone", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const waitForWindowLoad = (win: BrowserWindow): Promise<void> => {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      win.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        setTimeout(resolve, CAPTURE_SETTLE_DELAY_MS);
      });
    });
  };

  const runTransition = async (opts: {
    resumeHmr: () => Promise<void>;
  }): Promise<void> => {
    const fullWindow = deps.getFullWindow();
    const overlayController = deps.getOverlayController();

    if (!fullWindow || fullWindow.isDestroyed() || !overlayController) {
      await opts.resumeHmr();
      return;
    }

    // 1. Capture old state
    const oldScreenshot = await captureWindow(fullWindow);
    if (!oldScreenshot) {
      await opts.resumeHmr();
      return;
    }

    // 2. Start forward morph on overlay
    const bounds = fullWindow.getBounds();
    overlayController.startMorphForward(oldScreenshot, bounds);

    // 3. While the forward animation plays, resume HMR in parallel
    const hmrDone = (async () => {
      await new Promise((r) => setTimeout(r, Math.floor(FORWARD_ANIM_MS * 0.5)));

      const didStartLoading = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2000);
        fullWindow.webContents.once("did-start-loading", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      await opts.resumeHmr();

      const wasFullReload = await didStartLoading;

      if (wasFullReload) {
        await waitForWindowLoad(fullWindow);
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    })();

    // 4. Wait for forward animation to finish
    await new Promise((r) => setTimeout(r, FORWARD_ANIM_MS));

    // 5. Wait for HMR to settle
    await hmrDone;

    if (fullWindow.isDestroyed()) {
      overlayController.endMorph();
      return;
    }

    // 6. Capture new state
    const newScreenshot = await captureWindow(fullWindow);
    if (!newScreenshot) {
      overlayController.endMorph();
      return;
    }

    // 7. Start reverse immediately — no pause
    overlayController.startMorphReverse(newScreenshot);

    // 8. Wait for completion
    await waitForMorphDone();
    overlayController.endMorph();
  };

  return { runTransition };
}
