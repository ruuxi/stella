/**
 * HMR / self-mod morph timing — overlay `MorphTransition` + `hmr-morph.ts` only.
 * (Onboarding demo morphs keep separate constants for isolation; values are aligned manually.)
 *
 * Design principle: the morph cover should hide the entire visible renderer
 * transition. HMR/reload readiness signals can arrive before React/layout has
 * settled, so the second capture uses a fixed settle delay.
 */

/**
 * Cover: strength 0→steady with cosine easing (matches `tweenRef` in
 * MorphTransition). This gives the HMR cover an S-curve start instead of
 * popping straight into the ripple.
 */
export const MORPH_RENDERER_COVER_RAMP_MS = 550;
export const MORPH_RELOAD_COVER_RAMP_MS = 1050;

/**
 * Handoff: the reveal of the second capture. For the blur flavor this drives
 * the glimm band sweep; matches glimm's default 1100ms traversal so the
 * motion feels the same.
 */
export const MORPH_HANDOFF_FADE_MS = 1100;

/** Plateau strength during forward cover (fragment shader `u_strength`). */
export const MORPH_STEADY_STRENGTH = 0.65;

/** Baseline wait after Vite HMR/reload is triggered before capturing the new UI. */
export const MORPH_RENDERER_SETTLE_DELAY_MS = 1_200;

/** Fixed wait for covered renderer reloads before capturing the new UI. */
export const MORPH_RELOAD_SETTLE_DELAY_MS = 2_750;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;

/**
 * Dynamic settle (renderer readiness handshake).
 *
 * The second capture no longer waits a fixed duration; the renderer proves
 * readiness (Vite HMR batch fully applied / post-reload boot settled, then a
 * committed paint via double-rAF) and signals back. The old fixed delays
 * remain only as safety-net timeouts (×2 the previous values) so a hung
 * renderer can never wedge the morph — a warn log fires when they trip.
 */
export const MORPH_HMR_SETTLE_TIMEOUT_MS = MORPH_RENDERER_SETTLE_DELAY_MS * 2;
/**
 * Reload-tier ceiling is generous on purpose: telemetry showed a dev-mode
 * covered reload keeps the boot splash up for 6s+, so a tight (2×2750ms)
 * cap made capture #2 grab the splash — the visible "white flash". The
 * readiness poll exits the moment the splash clears, so the typical wait is
 * the actual boot time; the ceiling only bounds pathological hangs.
 */
export const MORPH_RELOAD_SETTLE_TIMEOUT_MS = 15_000;
/**
 * Reload tier only: extra fixed margin AFTER the event-driven readiness
 * (readyState + splash gone + committed-paint proof) passes, before
 * capture #2 is taken. Pure settle padding so the revealed frame has a
 * comfortable margin past readiness — the HMR tier does not use this.
 */
export const RELOAD_CAPTURE_EXTRA_SETTLE_MS = 500;
/** HMR batch counts as applied once no update is pending and none arrived for this long. */
export const MORPH_SETTLE_QUIET_MS = 120;
/**
 * How long the settle waiter keeps listening for the FIRST Vite update
 * before concluding the batch produced no renderer-visible HMR (e.g. it was
 * already applied before the waiter attached, or the overlay apply was a
 * no-op for this window).
 */
export const MORPH_SETTLE_ACTIVITY_GRACE_MS = 900;
/** Treat HMR activity this recent as "the batch we are waiting for". */
export const MORPH_SETTLE_RECENT_ACTIVITY_MS = 3_000;

export type MorphVisualTiming = {
  coverRampMs: number;
  handoffFadeMs: number;
};

export type MorphTimingTierSettings = MorphVisualTiming & {
  settleDelayMs: number;
};

export type MorphTimingSettings = {
  hmr: MorphTimingTierSettings;
  reload: MorphTimingTierSettings;
};

export const DEFAULT_MORPH_TIMING_SETTINGS: MorphTimingSettings = {
  hmr: {
    settleDelayMs: MORPH_RENDERER_SETTLE_DELAY_MS,
    coverRampMs: MORPH_RENDERER_COVER_RAMP_MS,
    handoffFadeMs: MORPH_HANDOFF_FADE_MS,
  },
  reload: {
    settleDelayMs: MORPH_RELOAD_SETTLE_DELAY_MS,
    coverRampMs: MORPH_RELOAD_COVER_RAMP_MS,
    handoffFadeMs: MORPH_HANDOFF_FADE_MS,
  },
};
