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
import type { SelfModHmrState } from "../../src/shared/contracts/electron-data.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";

const FORWARD_ANIM_MS = 800;
const CAPTURE_SETTLE_DELAY_MS = 150;
const MORPH_DONE_TIMEOUT_MS = 5000;

export type HmrMorphOrchestrator = {
  runTransition: (opts: {
    resumeHmr: () => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
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
      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        ipcMain.removeListener("overlay:morphDone", handler);
        resolve();
      }, MORPH_DONE_TIMEOUT_MS);

      ipcMain.once("overlay:morphDone", handler);
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
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }): Promise<void> => {
    const fullWindow = deps.getFullWindow();
    const overlayController = deps.getOverlayController();
    const emitState = (state: SelfModHmrState) => {
      overlayController?.setMorphState(state);
      opts.reportState?.(state);
    };
    const finish = () => {
      overlayController?.endMorph();
      opts.reportState?.(IDLE_HMR_STATE);
    };

    if (!fullWindow || fullWindow.isDestroyed() || !overlayController) {
      opts.reportState?.({
        phase: opts.requiresFullReload ? "reloading" : "applying",
        paused: false,
        requiresFullReload: opts.requiresFullReload,
      });
      await opts.resumeHmr();
      opts.reportState?.(IDLE_HMR_STATE);
      return;
    }

    // 1. Capture old state
    const oldScreenshot = await captureWindow(fullWindow);
    if (!oldScreenshot) {
      emitState({
        phase: opts.requiresFullReload ? "reloading" : "applying",
        paused: false,
        requiresFullReload: opts.requiresFullReload,
      });
      await opts.resumeHmr();
      opts.reportState?.(IDLE_HMR_STATE);
      return;
    }

    // 2. Start forward morph on overlay
    const bounds = fullWindow.getBounds();
    emitState({
      phase: "morph-forward",
      paused: false,
      requiresFullReload: opts.requiresFullReload,
    });
    overlayController.startMorphForward(oldScreenshot, bounds);

    // 3. While the forward animation plays, resume HMR in parallel
    const hmrDone = (async () => {
      await new Promise((r) => setTimeout(r, Math.floor(FORWARD_ANIM_MS * 0.5)));
      emitState({
        phase: "applying",
        paused: false,
        requiresFullReload: opts.requiresFullReload,
      });

      const didStartLoading = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2000);
        fullWindow.webContents.once("did-start-loading", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      await opts.resumeHmr();

      const wasFullReload = await didStartLoading;
      const requiresFullReload = opts.requiresFullReload || wasFullReload;

      if (requiresFullReload) {
        emitState({
          phase: "reloading",
          paused: false,
          requiresFullReload: true,
        });
      }

      if (wasFullReload) {
        await waitForWindowLoad(fullWindow);
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }

      return requiresFullReload;
    })();

    // 4. Wait for forward animation to finish
    await new Promise((r) => setTimeout(r, FORWARD_ANIM_MS));

    // 5. Wait for HMR to settle
    const requiresFullReload = await hmrDone;

    if (fullWindow.isDestroyed()) {
      finish();
      return;
    }

    // 6. Capture new state
    const newScreenshot = await captureWindow(fullWindow);
    if (!newScreenshot) {
      finish();
      return;
    }

    // 7. Start reverse immediately — no pause
    emitState({
      phase: "morph-reverse",
      paused: false,
      requiresFullReload,
    });
    overlayController.startMorphReverse(newScreenshot);

    // 8. Wait for completion
    await waitForMorphDone();
    finish();
  };

  return { runTransition };
}
