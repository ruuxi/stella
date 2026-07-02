/**
 * Renderer-side readiness signal for the self-mod morph's second capture.
 *
 * The Electron main process used to wait a FIXED delay after resuming HMR
 * before taking the post-apply screenshot (capture #2). Timers are guesses:
 * too short and the capture catches a mid-apply / white-flash frame, too
 * long and the morph cover lingers. This module replaces the guess with a
 * provable handshake:
 *
 *   1. Track Vite's global HMR stream (`vite:beforeUpdate` increments a
 *      pending counter, `vite:afterUpdate` decrements it, `vite:error`
 *      clears it). Multiple rapid updates in one self-mod batch therefore
 *      all count — readiness cannot fire between two updates of the same
 *      batch.
 *   2. `window.__stellaMorphSettle(opts)` (invoked by the main process via
 *      `webContents.executeJavaScript`, which awaits the returned promise)
 *      resolves once: no update is pending AND the stream has been quiet
 *      for `quietMs` — then `document.fonts.ready` (capped) and a
 *      double-`requestAnimationFrame`, proving a frame of the NEW state
 *      actually committed before the capture fires.
 *
 * Safety nets (never wedge the morph):
 *   - `timeoutMs` resolves the promise with `mode: "timeout"`.
 *   - If no HMR activity is observed at all within `activityGraceMs`, the
 *     waiter resolves with `mode: "no-activity"` (the batch may have been
 *     renderer-invisible, or applied before the waiter attached — recent
 *     activity within `recentActivityMs` is credited as ours).
 *
 * Loaded from `main.tsx` in dev; `import.meta.hot` is undefined in
 * production builds, where the module reduces to an inert global that
 * reports `hotAvailable: false` (main falls back to its fixed delay).
 */

export type MorphSettleOptions = {
  timeoutMs?: number;
  quietMs?: number;
  activityGraceMs?: number;
  recentActivityMs?: number;
};

export type MorphSettleResult = {
  mode: "signal" | "timeout" | "no-activity";
  hotAvailable: boolean;
  waitedMs: number;
  /** Total HMR events observed during the wait (beforeUpdate + afterUpdate + errors). */
  updatesSeen: number;
  /**
   * Distinct `vite:beforeUpdate` batches observed during the wait. For a
   * single self-mod apply this should equal the number of update payloads
   * Vite sends for the batch — if it ever reads ~2× the changed-module
   * count, the same update is being applied twice (echo class).
   */
  updateBatchesSeen: number;
  pendingAtEnd: number;
};

const DEFAULTS: Required<MorphSettleOptions> = {
  timeoutMs: 2_400,
  quietMs: 120,
  activityGraceMs: 900,
  recentActivityMs: 3_000,
};

const state = {
  pendingUpdates: 0,
  lastActivityAt: 0,
  eventSeq: 0,
  beforeUpdateSeq: 0,
  hotAvailable: false,
};

const touch = () => {
  state.lastActivityAt = performance.now();
  state.eventSeq += 1;
};

if (import.meta.hot) {
  state.hotAvailable = true;
  import.meta.hot.on("vite:beforeUpdate", () => {
    state.pendingUpdates += 1;
    state.beforeUpdateSeq += 1;
    touch();
  });
  import.meta.hot.on("vite:afterUpdate", () => {
    state.pendingUpdates = Math.max(0, state.pendingUpdates - 1);
    touch();
  });
  import.meta.hot.on("vite:error", () => {
    // A failed update never emits afterUpdate; clear so readiness can't
    // hang on a pending count that will never drain.
    state.pendingUpdates = 0;
    touch();
  });
  import.meta.hot.on("vite:beforeFullReload", () => {
    touch();
  });
}

/**
 * Committed-paint proof: capped fonts.ready, then two animation frames.
 *
 * CRITICAL: during the morph the full window sits fully occluded UNDER the
 * overlay window, so Chromium may pause rAF entirely — an uncapped rAF wait
 * deadlocks the whole morph (frost stuck on screen until the renderer is
 * torn down). rAF is therefore always raced against a hard cap, and a
 * forced synchronous style/layout flush guarantees the DOM state is
 * committed either way — `capturePage` renders its own compositor frame
 * from that state, so the capture is correct even when no rAF ever fired.
 */
const PAINT_PROOF_RAF_CAP_MS = 350;

const paintProof = (): Promise<void> =>
  new Promise((resolve) => {
    const fonts: Promise<unknown> =
      typeof document.fonts?.ready?.then === "function"
        ? document.fonts.ready.catch(() => undefined)
        : Promise.resolve();
    const fontsCap = new Promise((r) => setTimeout(r, 500));
    void Promise.race([fonts, fontsCap]).then(() => {
      // Force style recalc + layout of the freshly-applied DOM.
      try {
        void document.body?.offsetHeight;
      } catch {
        // layout flush is best-effort
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, PAINT_PROOF_RAF_CAP_MS);
    });
  });

const awaitMorphSettle = (
  options?: MorphSettleOptions,
): Promise<MorphSettleResult> => {
  const opts = { ...DEFAULTS, ...(options ?? {}) };
  const startedAt = performance.now();
  const baseSeq = state.eventSeq;
  const baseBeforeUpdateSeq = state.beforeUpdateSeq;

  return new Promise((resolve) => {
    let done = false;
    // Credit in-flight or just-finished activity to the batch we're waiting
    // for: the main process attaches this waiter AFTER the Vite plugin
    // accepted the apply, so the client may already be mid-update (or even
    // finished) by the time we start observing.
    let sawActivity =
      state.pendingUpdates > 0 ||
      (state.lastActivityAt > 0 &&
        startedAt - state.lastActivityAt <= opts.recentActivityMs);

    const finish = (mode: MorphSettleResult["mode"]) => {
      if (done) return;
      done = true;
      void paintProof().then(() =>
        resolve({
          mode,
          hotAvailable: state.hotAvailable,
          waitedMs: Math.round(performance.now() - startedAt),
          updatesSeen: state.eventSeq - baseSeq,
          updateBatchesSeen: state.beforeUpdateSeq - baseBeforeUpdateSeq,
          pendingAtEnd: state.pendingUpdates,
        }),
      );
    };

    const tick = () => {
      if (done) return;
      const now = performance.now();
      if (state.eventSeq !== baseSeq) sawActivity = true;
      if (now - startedAt >= opts.timeoutMs) {
        finish("timeout");
        return;
      }
      if (sawActivity) {
        if (
          state.pendingUpdates === 0 &&
          now - state.lastActivityAt >= opts.quietMs
        ) {
          finish("signal");
          return;
        }
      } else if (now - startedAt >= opts.activityGraceMs) {
        finish("no-activity");
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
};

declare global {
  interface Window {
    __stellaMorphSettle?: (
      options?: MorphSettleOptions,
    ) => Promise<MorphSettleResult>;
  }
}

window.__stellaMorphSettle = awaitMorphSettle;
