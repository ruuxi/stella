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

import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow } from "electron";
import type { SelfModHmrState } from "../../src/shared/contracts/boundary.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";

const OVERLAY_READY_TIMEOUT_MS = 500;
const CAPTURE_SETTLE_DELAY_MS = 80;
const MORPH_DONE_TIMEOUT_MS = 5000;

export type HmrTransitionController = {
  runTransition: (opts: {
    runId: string;
    resumeHmr: (
      options?: { suppressClientFullReload?: boolean },
    ) => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }) => Promise<void>;
};

const IDLE_HMR_STATE: SelfModHmrState = {
  phase: "idle",
  paused: false,
  requiresFullReload: false,
};

export function createHmrTransitionController(deps: {
  getFullWindow: () => BrowserWindow | null;
  getOverlayController: () => OverlayWindowController | null;
}): HmrTransitionController {
  const logMorphTiming = (
    phase: string,
    data: Record<string, number | boolean | string | null | undefined>,
  ) => {
    console.info("[stella:morph]", phase, data);
  };

  const captureWindow = async (win: BrowserWindow): Promise<string | null> => {
    const startedAt = performance.now();
    try {
      const image = await win.webContents.capturePage();
      logMorphTiming("capture", {
        durationMs: Math.round(performance.now() - startedAt),
        ok: true,
      });
      return image.toDataURL();
    } catch {
      logMorphTiming("capture", {
        durationMs: Math.round(performance.now() - startedAt),
        ok: false,
      });
      return null;
    }
  };

  const waitForOverlaySignal = (
    channel: "overlay:morphReady" | "overlay:morphDone",
    transitionId: string,
    timeoutMs: number,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      const handler = (
        _event: unknown,
        payload?: { transitionId?: string },
      ) => {
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
  };

  const waitForMorphDone = (transitionId: string) =>
    waitForOverlaySignal(
      "overlay:morphDone",
      transitionId,
      MORPH_DONE_TIMEOUT_MS,
    );

  const waitForWindowLoad = (win: BrowserWindow): Promise<void> => {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        logMorphTiming("waitForWindowLoad", {
          durationMs: Math.round(performance.now() - startedAt),
        });
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
    runId: string;
    resumeHmr: (
      options?: { suppressClientFullReload?: boolean },
    ) => Promise<void>;
    reportState?: (state: SelfModHmrState) => void;
    requiresFullReload: boolean;
  }): Promise<void> => {
    const fullWindow = deps.getFullWindow();
    const overlayController = deps.getOverlayController();
    const transitionId = randomUUID();
    const emitState = (state: SelfModHmrState) => {
      overlayController?.setMorphState(transitionId, state);
      opts.reportState?.(state);
    };
    const finish = () => {
      overlayController?.endMorph(transitionId);
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

    const overlayReadyForMorph = await overlayController.ensureReadyForMorph();
    if (!overlayReadyForMorph) {
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
    const transitionStartedAt = performance.now();
    const overlayReady = waitForOverlaySignal(
      "overlay:morphReady",
      transitionId,
      OVERLAY_READY_TIMEOUT_MS,
    );

    emitState({
      phase: "morph-forward",
      paused: false,
      requiresFullReload: opts.requiresFullReload,
    });
    overlayController.startMorphForward(
      transitionId,
      oldScreenshot,
      bounds,
      fullWindow,
    );

    // Once the forward morph starts the overlay is visible — finish() MUST run
    // to clean it up, even if an error occurs mid-transition.
    try {
      const hmrDone = (async () => {
        const overlayReadyStartedAt = performance.now();
        await overlayReady;
        logMorphTiming("overlayReady", {
          durationMs: Math.round(performance.now() - overlayReadyStartedAt),
        });

        emitState({
          phase: "applying",
          paused: false,
          requiresFullReload: opts.requiresFullReload,
        });

        const didStartLoading = new Promise<boolean>((resolve) => {
          const startedAt = performance.now();
          const timer = setTimeout(() => resolve(false), 2000);
          fullWindow.webContents.once("did-start-loading", () => {
            clearTimeout(timer);
            logMorphTiming("didStartLoading", {
              durationMs: Math.round(performance.now() - startedAt),
              started: true,
            });
            resolve(true);
          });
        });

        await opts.resumeHmr({
          suppressClientFullReload: opts.requiresFullReload,
        });

        if (opts.requiresFullReload) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          fullWindow.webContents.reloadIgnoringCache();
          await waitForWindowLoad(fullWindow);
          return true;
        }

        const wasFullReload = await didStartLoading;
        const requiresFullReload = wasFullReload;

        if (wasFullReload) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          await waitForWindowLoad(fullWindow);
        } else {
          const settleStartedAt = performance.now();
          await new Promise((resolve) => setTimeout(resolve, 200));
          logMorphTiming("softSettleWait", {
            durationMs: Math.round(performance.now() - settleStartedAt),
          });
        }

        return requiresFullReload;
      })();

      const requiresFullReload = await hmrDone;

      if (fullWindow.isDestroyed()) {
        return;
      }

      const newScreenshot = await captureWindow(fullWindow);
      if (!newScreenshot) {
        return;
      }

      emitState({
        phase: "morph-reverse",
        paused: false,
        requiresFullReload,
      });
      overlayController.startMorphReverse(
        transitionId,
        newScreenshot,
        requiresFullReload,
      );

      const reverseStartedAt = performance.now();
      await waitForMorphDone(transitionId);
      logMorphTiming("reverseMorph", {
        durationMs: Math.round(performance.now() - reverseStartedAt),
        totalDurationMs: Math.round(performance.now() - transitionStartedAt),
        requiresFullReload,
      });
    } finally {
      finish();
    }
  };

  return { runTransition };
}
