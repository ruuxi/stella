/**
 * Orchestrates the liquid morph transition during HMR resume.
 *
 * Flow:
 * 1. Capture old page state and tell the overlay to start morphing.
 * 2. Wait until the overlay confirms the first frame is painted.
 * 3. Resume HMR behind the covered main window.
 * 4. Wait for the renderer's READINESS SIGNAL (Vite HMR batch fully applied /
 *    post-reload boot settled, then a committed paint via double-rAF), then
 *    capture the new page state. Fixed delays remain only as safety-net
 *    timeouts — see `morph-settle-signal.ts` and `morph-timing.ts`.
 * 5. Immediately hand the overlay the new screenshot.
 * 6. Wait for the overlay to signal completion, then clean up.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { nativeImage, type BrowserWindow } from "electron";
import type { SelfModHmrState } from "../../../runtime/contracts/index.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  MORPH_DONE_TIMEOUT_MS,
  MORPH_HMR_SETTLE_TIMEOUT_MS,
  MORPH_OVERLAY_READY_TIMEOUT_MS,
  MORPH_RELOAD_SETTLE_DELAY_MS,
  MORPH_RELOAD_SETTLE_TIMEOUT_MS,
  MORPH_RENDERER_SETTLE_DELAY_MS,
  MORPH_SETTLE_ACTIVITY_GRACE_MS,
  MORPH_SETTLE_QUIET_MS,
  MORPH_SETTLE_RECENT_ACTIVITY_MS,
  RELOAD_CAPTURE_EXTRA_SETTLE_MS,
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

/**
 * Injected committed-paint proof for the reload tier: capped fonts.ready,
 * then two animation frames — proves the renderer painted a real frame of
 * the post-reload state instead of trusting a fixed post-readiness delay.
 * (The HMR tier goes through `window.__stellaMorphSettle`, which does the
 * same proof after the Vite update stream drains.)
 */
/**
 * Mean 0-255 brightness of a capture, from a 32px thumbnail. Used to detect
 * BLANK frames: capturePage returns the window's near-white backing when it
 * races a navigation (the renderer has no compositor frame at that instant).
 * Returns null when the image can't be decoded.
 */
const captureMeanLuma = (dataUrl: string): number | null => {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return null;
    const thumb = image.resize({ width: 32 });
    const bitmap = thumb.toBitmap(); // BGRA
    if (bitmap.length < 4) return null;
    let sum = 0;
    let count = 0;
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      sum += (bitmap[i]! + bitmap[i + 1]! + bitmap[i + 2]!) / 3;
      count += 1;
    }
    return count > 0 ? sum / count : null;
  } catch {
    return null;
  }
};

/** Above this mean the frame is effectively the blank white backing. */
const CAPTURE_BLANK_LUMA_THRESHOLD = 240;

const PAINT_PROOF_EXPRESSION = `(() => new Promise((resolve) => {
  const fonts = (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === "function")
    ? document.fonts.ready.catch(() => undefined)
    : Promise.resolve();
  const fontsCap = new Promise((r) => setTimeout(r, 500));
  Promise.race([fonts, fontsCap]).then(() => {
    try { void (document.body && document.body.offsetHeight); } catch {}
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(true); } };
    // rAF can be paused while the window sits occluded under the morph
    // overlay — never wait on it uncapped (see morph-settle-signal.ts).
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 350);
  });
}))()`;

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

  const waitForRendererReadyForCapture = async (
    windowForCapture: BrowserWindow,
    timeoutMs: number,
    options?: {
      /**
       * Only accept readiness from a document created at/after this epoch
       * ms (`performance.timeOrigin`). Without it the poll's first
       * iteration can run in the OLD renderer — readyState complete, no
       * splash — and pass instantly before the reload navigation even
       * starts, so capture #2 races the teardown (blank white frame).
       */
      requireDocumentNewerThanEpochMs?: number;
    },
  ) => {
    const startedAt = Date.now();
    let lastHadSplash = false;
    const minTimeOrigin = options?.requireDocumentNewerThanEpochMs;
    const observedTimeOrigins = new Set<number>();

    while (Date.now() - startedAt < timeoutMs) {
      if (windowForCapture.isDestroyed()) return;
      const ready = await windowForCapture.webContents
        .executeJavaScript(
          `(() => {
            const splash = document.getElementById("stella-launch");
            return {
              ready: document.readyState === "complete",
              hasSplash: Boolean(splash),
              timeOrigin: performance.timeOrigin,
            };
          })()`,
          true,
        )
        .catch(() => null);
      const timeOrigin =
        ready && typeof ready === "object"
          ? Number((ready as { timeOrigin?: unknown }).timeOrigin)
          : Number.NaN;
      if (Number.isFinite(timeOrigin)) {
        observedTimeOrigins.add(Math.round(timeOrigin));
      }
      const documentIsNewEnough =
        minTimeOrigin == null ||
        (Number.isFinite(timeOrigin) && timeOrigin >= minTimeOrigin - 100);
      if (
        ready &&
        typeof ready === "object" &&
        (ready as { ready?: unknown }).ready === true &&
        documentIsNewEnough
      ) {
        lastHadSplash =
          (ready as { hasSplash?: unknown }).hasSplash === true;
        if (!lastHadSplash) {
          if (observedTimeOrigins.size > 1) {
            // More than one document seen during this wait: something
            // besides our covered reload navigated the renderer (e.g. a
            // client-initiated Vite full reload). Surface it — this was
            // the hard-reload white-flash source.
            console.warn(
              "[self-mod-hmr] settle(reload): multiple renderer documents observed during covered reload",
              { documentsSeen: observedTimeOrigins.size },
            );
          }
          // Readiness conditions met — now prove a committed paint of the
          // post-reload state (self-capped: fonts.ready ≤500ms, rAF ≤350ms).
          // Outer race so a fully stalled renderer can never wedge the morph.
          const painted = await Promise.race([
            windowForCapture.webContents
              .executeJavaScript(PAINT_PROOF_EXPRESSION, true)
              .then(() => true)
              .catch(() => false),
            delay(1_500).then(() => false),
          ]);
          if (!painted) {
            console.warn(
              "[self-mod-hmr] settle(reload): paint-proof unavailable; using fixed fallback delay",
            );
            await delay(300);
          }
          // Extra settle margin: readiness has provably passed — hold a
          // fixed beat more before the photo (reload tier only).
          await delay(RELOAD_CAPTURE_EXTRA_SETTLE_MS);
          return;
        }
      }
      await delay(50);
    }

    // Safety net: the splash should normally clear quickly, but never wedge
    // the self-mod path if the renderer gets stuck before reporting
    // readiness.
    console.warn("[self-mod-hmr] settle(reload): timed out waiting for renderer readiness", {
      timeoutMs,
      lastHadSplash,
    });
    await delay(lastHadSplash ? 250 : 0);
  };

  /**
   * HMR-tier dynamic settle: ask the renderer to signal once the Vite update
   * stream has drained and a frame of the new state committed
   * (`__stellaMorphSettle`, installed by `platform/dev/morph-settle-signal`).
   * Falls back to the legacy fixed delay when the signal is unavailable
   * (production bundle, injection failure, pre-signal renderer).
   */
  const waitForRendererHmrSettled = async (
    windowForCapture: BrowserWindow,
  ) => {
    if (windowForCapture.isDestroyed()) return;
    const startedAt = Date.now();
    // Outer race: even a wedged renderer promise (e.g. rAF paused while the
    // window is occluded under the overlay) must never hang the morph. The
    // renderer waiter's own timeout should fire well before this.
    const OUTER_TIMEOUT_SENTINEL = "__outer-timeout__";
    const result = await Promise.race([
      windowForCapture.webContents
        .executeJavaScript(
          `(() => (typeof window.__stellaMorphSettle === "function"
            ? window.__stellaMorphSettle({
                timeoutMs: ${MORPH_HMR_SETTLE_TIMEOUT_MS},
                quietMs: ${MORPH_SETTLE_QUIET_MS},
                activityGraceMs: ${MORPH_SETTLE_ACTIVITY_GRACE_MS},
                recentActivityMs: ${MORPH_SETTLE_RECENT_ACTIVITY_MS},
              })
            : null))()`,
          true,
        )
        .catch(() => null),
      delay(MORPH_HMR_SETTLE_TIMEOUT_MS + 1_500).then(
        () => OUTER_TIMEOUT_SENTINEL,
      ),
    ]);

    if (result === OUTER_TIMEOUT_SENTINEL) {
      console.warn(
        "[self-mod-hmr] settle(hmr): renderer settle promise hung past outer timeout; proceeding to capture",
        { outerTimeoutMs: MORPH_HMR_SETTLE_TIMEOUT_MS + 1_500 },
      );
      return;
    }

    if (!result || typeof result !== "object") {
      console.warn(
        "[self-mod-hmr] settle(hmr): renderer signal unavailable; using fixed fallback delay",
        { fallbackDelayMs: MORPH_RENDERER_SETTLE_DELAY_MS },
      );
      await delay(MORPH_RENDERER_SETTLE_DELAY_MS);
      return;
    }

    const settle = result as { mode?: string; waitedMs?: number };
    if (settle.mode === "timeout") {
      console.warn(
        "[self-mod-hmr] settle(hmr): timed out waiting for renderer readiness",
        { ...settle, totalMs: Date.now() - startedAt },
      );
    }
  };

  const isRendererShowingCrashSurface = async (
    windowForCapture: BrowserWindow,
  ): Promise<boolean> => {
    if (windowForCapture.isDestroyed()) return false;
    return await windowForCapture.webContents
      .executeJavaScript(
        `Boolean(document.querySelector(".error-boundary"))`,
        true,
      )
      .then(Boolean)
      .catch(() => false);
  };

  const reloadRendererUnderMorph = async (
    windowForReload: BrowserWindow,
  ) => {
    await windowForReload.webContents
      .executeJavaScript(
        `(() => {
          sessionStorage.setItem("stella:morph-reload", "1");
          // Defuse the Vite client's ws-disconnect self-reload: our
          // reloadIgnoringCache can close the old document's HMR socket
          // before its real unload handler runs, and the client then does
          // "server connection lost. Polling for restart..." →
          // location.reload() on the DYING document — a second, uncovered
          // navigation racing ours (the hard-reload white flash). The
          // client guards that path with a willUnload flag set on
          // window "beforeunload"; dispatching it synthetically arms the
          // guard before we tear the document down.
          try { window.dispatchEvent(new Event("beforeunload")); } catch {}
          return true;
        })()`,
        true,
      )
      .catch(() => undefined);
    const reloadInitiatedAtEpochMs = Date.now();
    windowForReload.webContents.reloadIgnoringCache();
    // Safety-net timeout only — the poll exits as soon as the renderer is
    // ready (on a document newer than the reload) and a committed paint is
    // proven.
    await waitForRendererReadyForCapture(
      windowForReload,
      MORPH_RELOAD_SETTLE_TIMEOUT_MS,
      { requireDocumentNewerThanEpochMs: reloadInitiatedAtEpochMs },
    );
  };

  const selectTierTiming = (
    requiresFullReload: boolean,
  ): MorphTimingTierSettings =>
    requiresFullReload
      ? DEFAULT_MORPH_TIMING_SETTINGS.reload
      : DEFAULT_MORPH_TIMING_SETTINGS.hmr;

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

    // The full window spends the whole morph fully occluded under the
    // overlay. In that state Chromium pauses rAF AND stops submitting
    // compositor frames — capturePage then returns the last presented frame
    // (after a reload gap that is the blank white backing, endlessly, which
    // was the persistent source of white capture #2s). Disable background
    // throttling for the duration of the cover so the renderer keeps
    // producing real frames; restored in the finally below.
    let backgroundThrottlingDisabled = false;
    try {
      fullWindow.webContents.setBackgroundThrottling(false);
      backgroundThrottlingDisabled = true;
    } catch (error) {
      console.warn(
        "[self-mod-hmr] setBackgroundThrottling(false) failed:",
        (error as Error).message,
      );
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
        const overlayFirstFrame = await overlayReady;
        if (!overlayFirstFrame) {
          console.warn(
            "[self-mod-hmr] overlay first-frame signal timed out; proceeding",
            { timeoutMs: MORPH_OVERLAY_READY_TIMEOUT_MS },
          );
        }

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
          await reloadRendererUnderMorph(fullWindow);
          return true;
        }

        await waitForRendererHmrSettled(fullWindow);
        if (await isRendererShowingCrashSurface(fullWindow)) {
          emitState({
            phase: "reloading",
            paused: false,
            requiresFullReload: true,
          });
          await reloadRendererUnderMorph(fullWindow);
          return true;
        }
        return false;
      })();

      const requiresFullReload = await hmrDone;

      if (fullWindow.isDestroyed()) {
        return;
      }

      // Whiteness-gated capture: capturePage returns the blank white window
      // backing when it races a renderer navigation (e.g. a stray reload
      // landing between settle and capture). Never hand a blank frame to
      // the overlay — recapture after the renderer settles again.
      let newScreenshot: string | null = null;
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        if (fullWindow.isDestroyed()) break;
        // Force a fresh compositor frame before capturing — under the
        // overlay the window may otherwise serve a stale (blank) frame.
        try {
          fullWindow.webContents.invalidate();
        } catch {
          // best-effort
        }
        await delay(60);
        newScreenshot = await captureWindowDataUrl(fullWindow);
        const captureLuma = newScreenshot
          ? captureMeanLuma(newScreenshot)
          : null;
        const isBlank =
          captureLuma != null && captureLuma >= CAPTURE_BLANK_LUMA_THRESHOLD;
        if (newScreenshot && !isBlank) break;
        console.warn("[self-mod-hmr] capture2 blank/failed; recapturing", {
          attempt,
          meanLuma: captureLuma,
          hasImage: Boolean(newScreenshot),
        });
        // A blank frame means the renderer is (re)navigating — wait for it
        // to become ready again before the next attempt.
        await waitForRendererReadyForCapture(
          fullWindow,
          MORPH_RELOAD_SETTLE_TIMEOUT_MS,
        );
      }
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

      const morphDoneSignaled = await waitForMorphDone(transitionId);
      if (!morphDoneSignaled) {
        console.warn("[self-mod-hmr] morph-done signal timed out", {
          timeoutMs: MORPH_DONE_TIMEOUT_MS,
        });
      }
    } finally {
      if (backgroundThrottlingDisabled) {
        try {
          fullWindow.webContents.setBackgroundThrottling(true);
        } catch {
          // best-effort restore
        }
      }
      finish();
    }
  };

  return { runTransition };
}
