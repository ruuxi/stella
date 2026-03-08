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

import { app, type BrowserWindow } from "electron";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { NativeOverlayController } from "../windows/native-overlay.js";

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
  getNativeOverlay: () => NativeOverlayController | null;
}): HmrMorphOrchestrator {

  const captureToFile = async (win: BrowserWindow, label: string): Promise<string | null> => {
    try {
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      const filePath = path.join(app.getPath("temp"), `stella_morph_${label}_${Date.now()}.png`);
      await writeFile(filePath, png);
      return filePath;
    } catch {
      return null;
    }
  };

  const cleanupFile = (filePath: string | null) => {
    if (filePath) void unlink(filePath).catch(() => {});
  };

  const waitForMorphDone = (overlay: NativeOverlayController): Promise<void> => {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, MORPH_DONE_TIMEOUT_MS);
      overlay.onMorphDone(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const waitForWindowLoad = (win: BrowserWindow): Promise<void> => {
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      const timer = setTimeout(() => {
        win.webContents.removeListener("did-finish-load", onLoad);
        done();
      }, 5000);
      const onLoad = () => {
        clearTimeout(timer);
        setTimeout(done, CAPTURE_SETTLE_DELAY_MS);
      };
      win.webContents.once("did-finish-load", onLoad);
    });
  };

  const runTransition = async (opts: {
    resumeHmr: () => Promise<void>;
  }): Promise<void> => {
    const fullWindow = deps.getFullWindow();
    const nativeOverlay = deps.getNativeOverlay();

    if (!fullWindow || fullWindow.isDestroyed() || !nativeOverlay) {
      await opts.resumeHmr();
      return;
    }

    // 1. Capture old state to temp file
    const oldScreenshot = await captureToFile(fullWindow, "old");
    if (!oldScreenshot) {
      await opts.resumeHmr();
      return;
    }

    // 2. Start forward morph on native overlay
    const bounds = fullWindow.getBounds();
    nativeOverlay.startMorphForward(oldScreenshot, bounds);

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
      nativeOverlay.endMorph();
      cleanupFile(oldScreenshot);
      return;
    }

    // 6. Capture new state to temp file
    const newScreenshot = await captureToFile(fullWindow, "new");
    if (!newScreenshot) {
      nativeOverlay.endMorph();
      cleanupFile(oldScreenshot);
      return;
    }

    // 7. Start reverse immediately — no pause
    nativeOverlay.startMorphReverse(newScreenshot);

    // 8. Wait for completion
    await waitForMorphDone(nativeOverlay);
    nativeOverlay.endMorph();

    // 9. Cleanup temp files
    cleanupFile(oldScreenshot);
    cleanupFile(newScreenshot);
  };

  return { runTransition };
}
