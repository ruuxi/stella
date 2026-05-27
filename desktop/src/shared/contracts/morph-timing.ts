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
export const MORPH_RENDERER_COVER_RAMP_MS = 200;
export const MORPH_RELOAD_COVER_RAMP_MS = 400;

/** Handoff: `u_mix` 0→1 and strength →0 once the second capture is ready. */
export const MORPH_HANDOFF_FADE_MS = 500;

/** Plateau strength during forward cover (fragment shader `u_strength`). */
export const MORPH_STEADY_STRENGTH = 0.65;

/** Baseline wait after Vite HMR/reload is triggered before capturing the new UI. */
export const MORPH_RENDERER_SETTLE_DELAY_MS = 250;

/** Fixed wait for covered renderer reloads before capturing the new UI. */
export const MORPH_RELOAD_SETTLE_DELAY_MS = 1_250;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;

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
