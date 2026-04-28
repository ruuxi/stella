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

/** Baseline wait after Vite HMR/reload is triggered before capturing the new UI. */
export const MORPH_RENDERER_SETTLE_DELAY_MS = 800;

/**
 * Hard cap on the settle wait when a renderer reload is in flight. Reloads
 * driven either by `requiresFullReload` or by a late React-Refresh bail-out
 * (`{type:'full-reload'}` sent by Vite after we apply an HMR update) extend
 * the cover until `did-finish-load` plus a small grace, but never past this.
 */
export const MORPH_RENDERER_SETTLE_HARD_CAP_MS = 5_000;

/** Grace after `did-finish-load` so React/Convex hydration has a chance to paint. */
export const MORPH_POST_RELOAD_GRACE_MS = 200;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;
