/**
 * HMR / self-mod morph timing — overlay `MorphTransition` + `hmr-morph.ts` only.
 * (Onboarding demo morphs keep separate constants for isolation; values are aligned manually.)
 *
 * Design principle: the morph cover should hide the entire visible renderer
 * transition. HMR/reload readiness signals can arrive before React/layout has
 * settled, so the second capture uses a fixed settle delay.
 */

/** Reverse: `u_mix` 0→1 and strength →0 with cosine easing (matches `tweenRef` in MorphTransition).
 *  No forward-ramp constant: HMR-flavor cover snaps directly to steady
 *  state — the wind-up tween is too brief to register and just adds
 *  visual stutter. Onboarding still tweens (using its own constant). */
export const MORPH_REVERSE_CROSSFADE_MS = 180;

/** Plateau strength during forward cover (fragment shader `u_strength`). */
export const MORPH_STEADY_STRENGTH = 0.65;

/** Fixed wait after Vite HMR/reload is triggered before capturing the new UI. */
export const MORPH_RENDERER_SETTLE_DELAY_MS = 800;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;
