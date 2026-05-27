/**
 * Orchestrates the liquid morph transition during HMR resume.
 *
 * Flow:
 * 1. Capture old page state and tell the overlay to start morphing.
 * 2. Wait until the overlay confirms the first frame is painted.
 * 3. Resume HMR behind the covered main window.
 * 4. Wait for load to settle, then capture the new page state.
 * 5. Immediately hand the overlay the new screenshot.
 * 6. Wait for the overlay to signal completion, then clean up.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import type { SelfModHmrState } from "../../../runtime/contracts/index.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  MORPH_DONE_TIMEOUT_MS,
  MORPH_OVERLAY_READY_TIMEOUT_MS,
  MORPH_RELOAD_SETTLE_DELAY_MS,
  MORPH_RENDERER_SETTLE_DELAY_MS,
  type MorphTimingTierSettings,
} from "../../src/shared/contracts/morph-timing.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import {
  captureWindowDataUrl,
  waitForOverlayMorphSignal,
} from "../windows/morph-transition-helpers.js";
import { shouldShowMorphForWindow } from "../windows/morph-visibility.js";

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
    requiresRuntimeRestart?: boolean;
    requiresProcessRestart?: boolean;
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
   * longer wait so the morph handoff never depends on Electron load events
   * that can be skipped during dev-server/runtime reinitialization.
   */
  const createRendererSettle = (
    options?: { expectReload?: boolean; settleDelayMs?: number },
  ): { wait: () => Promise<void> } => {
    const settleDelayMs =
      options?.settleDelayMs ??
      (options?.expectReload === true
        ? MORPH_RELOAD_SETTLE_DELAY_MS
        : MORPH_RENDERER_SETTLE_DELAY_MS);
    return {
      wait: async () => {
        await delay(settleDelayMs);
      },
    };
  };

  const selectTierTiming = (
    requiresFullReload: boolean,
  ): MorphTimingTierSettings => {
    return requiresFullReload
      ? DEFAULT_MORPH_TIMING_SETTINGS.reload
      : DEFAULT_MORPH_TIMING_SETTINGS.hmr;
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
    requiresRuntimeRestart?: boolean;
    requiresProcessRestart?: boolean;
  }): Promise<void> => {
    const fullWindow = deps.getFullWindow();
    const overlayController = deps.getOverlayController();
    const transitionId = randomUUID();
    const tierTiming = selectTierTiming(opts.requiresFullReload);
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
      const suppressClientFullReload =
        opts.requiresFullReload ||
        opts.requiresRuntimeRestart === true ||
        opts.requiresProcessRestart === true;
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
          suppressClientFullReload,
        });
        const shouldReload =
          canReload ||
          (!suppressClientFullReload &&
            applyResult?.requiresClientFullReload === true);
        const settle = createRendererSettle({
          expectReload: shouldReload,
          settleDelayMs: shouldReload
            ? tierTiming.settleDelayMs
            : DEFAULT_MORPH_TIMING_SETTINGS.hmr.settleDelayMs,
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

    if (opts.requiresProcessRestart === true) {
      opts.reportState?.({
        phase: "applying",
        paused: false,
        requiresFullReload: false,
      });
      try {
        await opts.applyBatch({ suppressClientFullReload: true });
      } finally {
        opts.reportState?.(IDLE_HMR_STATE);
      }
      return;
    }

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

    const visibilityDecision = await shouldShowMorphForWindow(fullWindow);
    if (!visibilityDecision.showMorph) {
      console.info("[self-mod-hmr] Applying without morph cover:", {
        reason: "target-window-not-visible",
        visibility: visibilityDecision,
        runIds: opts.runIds,
        requiresFullReload: opts.requiresFullReload,
      });
      await applyWithoutMorph(fullWindow);
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
          "hmr",
          tierTiming,
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

        const suppressClientFullReload =
          opts.requiresFullReload ||
          opts.requiresRuntimeRestart === true ||
          opts.requiresProcessRestart === true;
        const applyResult = await opts.applyBatch({
          suppressClientFullReload,
        });

        const requiresClientFullReload =
          opts.requiresFullReload ||
          (!suppressClientFullReload &&
            applyResult?.requiresClientFullReload === true);

        if (requiresClientFullReload) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          const settle = createRendererSettle({
            expectReload: true,
            settleDelayMs: tierTiming.settleDelayMs,
          });
          fullWindow.webContents.reloadIgnoringCache();
          await settle.wait();
          return true;
        }

        const settle = createRendererSettle({
          settleDelayMs: tierTiming.settleDelayMs,
        });
        await settle.wait();
        return false;
      })();

      const requiresFullReload = await hmrDone;

      if (fullWindow.isDestroyed()) {
        return;
      }

      const newScreenshot = await captureWindowDataUrl(fullWindow);
      if (!newScreenshot) {
        console.warn("[self-mod-hmr] Morph handoff skipped:", {
          reason: "post-capture-failed",
          runIds: opts.runIds,
          requiresFullReload,
        });
        return;
      }

      emitState({
        phase: "morph-handoff",
        paused: false,
        requiresFullReload,
      });
      overlayController.startMorphHandoff(
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
