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
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { SelfModHmrState } from "../../src/shared/contracts/boundary.js";
import {
  MORPH_DONE_TIMEOUT_MS,
  MORPH_OVERLAY_READY_TIMEOUT_MS,
  MORPH_POST_RELOAD_GRACE_MS,
  MORPH_RENDERER_SETTLE_DELAY_MS,
  MORPH_RENDERER_SETTLE_HARD_CAP_MS,
} from "../../src/shared/contracts/morph-timing.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import {
  captureWindowDataUrl,
  waitForOverlayMorphSignal,
} from "../windows/morph-transition-helpers.js";

export type HmrTransitionController = {
  runTransition: (opts: {
    /**
     * The run ids whose changes are being applied in this single morph
     * cover. Typically a single run, but can be the entire batch if a
     * held run drained alongside the finalizing run.
    */
    runIds: string[];
    stateRunIds?: string[];
    /**
     * Performs the actual overlay apply on the Vite plugin while the
     * cover is on screen. Replaces the old `resumeHmr` callback — the
     * controller calls this once the cover has captured the pre-apply
     * screenshot and is ready for the renderer to swap.
     */
    applyBatch: (
      options?: {
        suppressClientFullReload?: boolean;
        forceClientFullReload?: boolean;
      },
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
  const waitForMorphDone = (transitionId: string) =>
    waitForOverlayMorphSignal(
      "overlay:morphDone",
      transitionId,
      MORPH_DONE_TIMEOUT_MS,
    );

  /**
   * Arms the `did-start-loading` / `did-finish-load` listeners synchronously
   * and returns a `wait()` that holds the morph cover for at least
   * `MORPH_RENDERER_SETTLE_DELAY_MS`. If the renderer starts a navigation
   * during that window — either an intentional `reloadIgnoringCache` we
   * issue right after `arm()`, or a late `{type:'full-reload'}` that Vite
   * sent after we applied an HMR update (React-Refresh boundary bail-out) —
   * the wait extends until `did-finish-load + MORPH_POST_RELOAD_GRACE_MS`,
   * capped at `MORPH_RENDERER_SETTLE_HARD_CAP_MS`.
   *
   * IMPORTANT: callers must arm first, then call `reloadIgnoringCache()`
   * synchronously, then `await wait()`. Attaching the listener after the
   * reload call races with Chromium's `did-start-loading` emission and we
   * routinely missed the event (the log shows `reloadDetected:false` while
   * a reload is plainly in flight, lifting the cover at the baseline 800ms).
   */
  const armRendererSettle = (
    window: BrowserWindow | null,
  ): { wait: () => Promise<void> } => {
    if (!window || window.isDestroyed()) {
      return {
        wait: async () => {
          await delay(MORPH_RENDERER_SETTLE_DELAY_MS);
        },
      };
    }
    const wc = window.webContents;
    let reloadDetected = false;
    let resolveReloadDone: (() => void) | null = null;
    const reloadDone = new Promise<void>((resolve) => {
      resolveReloadDone = resolve;
    });
    const onStartLoading = () => {
      reloadDetected = true;
      const onFinish = () => {
        setTimeout(() => resolveReloadDone?.(), MORPH_POST_RELOAD_GRACE_MS);
      };
      wc.once("did-finish-load", onFinish);
    };
    wc.on("did-start-loading", onStartLoading);
    return {
      wait: async () => {
        try {
          await delay(MORPH_RENDERER_SETTLE_DELAY_MS);
          if (reloadDetected) {
            const remainingCap = Math.max(
              0,
              MORPH_RENDERER_SETTLE_HARD_CAP_MS - MORPH_RENDERER_SETTLE_DELAY_MS,
            );
            await Promise.race([reloadDone, delay(remainingCap)]);
          }
        } finally {
          wc.removeListener("did-start-loading", onStartLoading);
        }
      },
    };
  };

  const runTransition = async (opts: {
    runIds: string[];
    stateRunIds?: string[];
    applyBatch: (
      options?: {
        suppressClientFullReload?: boolean;
        forceClientFullReload?: boolean;
      },
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
    const applyWithoutMorph = async (
      windowForReload: BrowserWindow | null,
    ) => {
      opts.reportState?.({
        phase: opts.requiresFullReload ? "reloading" : "applying",
        paused: false,
        requiresFullReload: opts.requiresFullReload,
      });
      const canReload =
        opts.requiresFullReload &&
        windowForReload != null &&
        !windowForReload.isDestroyed();
      try {
        await opts.applyBatch({
          suppressClientFullReload: canReload,
        });
        // Arm before reloading so the did-start-loading listener can never
        // miss the event Chromium emits in response to reloadIgnoringCache.
        const settle = armRendererSettle(windowForReload);
        if (canReload) {
          windowForReload.webContents.reloadIgnoringCache();
        }
        await settle.wait();
      } finally {
        opts.reportState?.(IDLE_HMR_STATE);
      }
    };

    if (!fullWindow || fullWindow.isDestroyed() || !overlayController) {
      await applyWithoutMorph(
        fullWindow && !fullWindow.isDestroyed() ? fullWindow : null,
      );
      return;
    }

    // Run overlay-readiness check + screenshot capture concurrently. Overlay
    // is typically already warm so this just hides capture latency behind any
    // readiness wait we'd have done anyway. (`emitState` would be a no-op for
    // both branches here — the overlay controller's `setMorphState` gates on
    // `activeMorphTransitionId`, which is only set in `startMorphForward`.)
    const [overlayReadyForMorph, oldScreenshot] = await Promise.all([
      overlayController.ensureReadyForMorph(),
      captureWindowDataUrl(fullWindow),
    ]);
    if (!overlayReadyForMorph || !oldScreenshot) {
      await applyWithoutMorph(fullWindow);
      return;
    }

    const bounds = fullWindow.getBounds();
    const overlayReady = waitForOverlayMorphSignal(
      "overlay:morphReady",
      transitionId,
      MORPH_OVERLAY_READY_TIMEOUT_MS,
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
        await overlayReady;

        emitState({
          phase: "applying",
          paused: false,
          requiresFullReload: opts.requiresFullReload,
        });

        await opts.applyBatch({
          suppressClientFullReload: opts.requiresFullReload,
        });

        if (opts.requiresFullReload) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          // Arm the settle listeners BEFORE reloadIgnoringCache so the
          // did-start-loading event Chromium emits in response to the
          // reload can't be missed by a late listener attach.
          const settle = armRendererSettle(fullWindow);
          fullWindow.webContents.reloadIgnoringCache();
          await settle.wait();
          return true;
        }

        // No intentional reload here, but late React-Refresh bail-outs may
        // still trigger one — arm the listener so we extend the cover if
        // they do.
        const settle = armRendererSettle(fullWindow);
        await settle.wait();
        return false;
      })();

      const requiresFullReload = await hmrDone;

      if (fullWindow.isDestroyed()) {
        return;
      }

      const newScreenshot = await captureWindowDataUrl(fullWindow);
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

      await waitForMorphDone(transitionId);
    } finally {
      finish();
    }
  };

  return { runTransition };
}
