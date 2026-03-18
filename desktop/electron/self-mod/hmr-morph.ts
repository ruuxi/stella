/**
 * Orchestrates the liquid morph transition during HMR resume.
 *
 * Flow:
 * 1. Capture old page state and tell the overlay to start morphing.
 * 2. Wait until the overlay confirms the first frame is painted.
 * 3. Resume HMR behind the covered main window.
 * 4. Wait for load to settle, then capture the new page state.
 * 5. Immediately tell the overlay to reverse with the new screenshot.
 * 6. Wait for the overlay to signal completion, then clean up.
 */

import { ipcMain, type BrowserWindow } from "electron";
import type { SelfModHmrState } from "../../src/shared/contracts/electron-data.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";

const MIN_COVER_MS = 160;
const OVERLAY_READY_TIMEOUT_MS = 500;
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

  const waitForOverlaySignal = (
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

  const waitForMorphDone = () =>
    waitForOverlaySignal("overlay:morphDone", MORPH_DONE_TIMEOUT_MS);

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

    const bounds = fullWindow.getBounds();
    const coverStartedAt = Date.now();
    const overlayReady = waitForOverlaySignal(
      "overlay:morphReady",
      OVERLAY_READY_TIMEOUT_MS,
    );

    emitState({
      phase: "morph-forward",
      paused: false,
      requiresFullReload: opts.requiresFullReload,
    });
    overlayController.startMorphForward(oldScreenshot, bounds);

    const hmrDone = (async () => {
      await overlayReady;

      const remainingCoverMs = MIN_COVER_MS - (Date.now() - coverStartedAt);
      if (remainingCoverMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingCoverMs));
      }

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
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      return requiresFullReload;
    })();

    const requiresFullReload = await hmrDone;

    if (fullWindow.isDestroyed()) {
      finish();
      return;
    }

    const newScreenshot = await captureWindow(fullWindow);
    if (!newScreenshot) {
      finish();
      return;
    }

    emitState({
      phase: "morph-reverse",
      paused: false,
      requiresFullReload,
    });
    overlayController.startMorphReverse(newScreenshot, requiresFullReload);

    await waitForMorphDone();
    finish();
  };

  return { runTransition };
}
