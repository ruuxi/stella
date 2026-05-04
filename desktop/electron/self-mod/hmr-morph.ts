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
import type { SelfModHmrState } from "../../../runtime/contracts/index.js";
import {
  MORPH_DONE_TIMEOUT_MS,
  MORPH_OVERLAY_READY_TIMEOUT_MS,
  MORPH_RELOAD_SETTLE_DELAY_MS,
  MORPH_RENDERER_SETTLE_DELAY_MS,
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
    ) => Promise<{ requiresClientFullReload?: boolean } | void>;
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
   * Quiet HMR uses the short baseline wait. Covered reloads use a fixed
   * longer wait so the morph reverse never depends on Electron load events
   * that can be skipped during dev-server/runtime reinitialization.
   */
  const createRendererSettle = (
    options?: { expectReload?: boolean },
  ): { wait: () => Promise<void> } => {
    const settleDelayMs =
      options?.expectReload === true
        ? MORPH_RELOAD_SETTLE_DELAY_MS
        : MORPH_RENDERER_SETTLE_DELAY_MS;
    return {
      wait: async () => {
        await delay(settleDelayMs);
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
    ) => Promise<{ requiresClientFullReload?: boolean } | void>;
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
        const applyResult = await opts.applyBatch({
          suppressClientFullReload: canReload,
        });
        const shouldReload =
          canReload || applyResult?.requiresClientFullReload === true;
        const settle = createRendererSettle({
          expectReload: shouldReload,
        });
        if (
          shouldReload &&
          windowForReload != null &&
          !windowForReload.isDestroyed()
        ) {
          windowForReload.webContents.reloadIgnoringCache();
        }
        await settle.wait();
      } finally {
        opts.reportState?.(IDLE_HMR_STATE);
      }
    };

    if (!fullWindow || fullWindow.isDestroyed() || !overlayController) {
      console.warn("[self-mod-hmr] Applying without morph cover:", {
        reason: !fullWindow || fullWindow.isDestroyed()
          ? "missing-full-window"
          : "missing-overlay-controller",
        runIds: opts.runIds,
        requiresFullReload: opts.requiresFullReload,
      });
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
      console.warn("[self-mod-hmr] Applying without morph cover:", {
        reason: !overlayReadyForMorph
          ? "overlay-not-ready"
          : "pre-capture-failed",
        runIds: opts.runIds,
        requiresFullReload: opts.requiresFullReload,
        overlayReadyForMorph,
        hasOldScreenshot: Boolean(oldScreenshot),
      });
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

        const applyResult = await opts.applyBatch({
          suppressClientFullReload: opts.requiresFullReload,
        });

        const requiresClientFullReload =
          opts.requiresFullReload ||
          applyResult?.requiresClientFullReload === true;

        if (requiresClientFullReload) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          const settle = createRendererSettle({
            expectReload: true,
          });
          fullWindow.webContents.reloadIgnoringCache();
          await settle.wait();
          return true;
        }

        const settle = createRendererSettle();
        await settle.wait();
        return false;
      })();

      const requiresFullReload = await hmrDone;

      if (fullWindow.isDestroyed()) {
        return;
      }

      const newScreenshot = await captureWindowDataUrl(fullWindow);
      if (!newScreenshot) {
        console.warn("[self-mod-hmr] Morph reverse skipped:", {
          reason: "post-capture-failed",
          runIds: opts.runIds,
          requiresFullReload,
        });
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
