/**
 * HMR / self-mod morph timing — overlay `MorphTransition` + `hmr-morph.ts` only.
 * (Onboarding demo morphs keep separate constants for isolation; values are aligned manually.)
 */

/** Forward: ripple / cover strength ramps to steady state. */
export const MORPH_COVER_RAMP_UP_MS = 220;

/** Reverse: `u_mix` 0→1 and strength →0 with cosine easing (matches `tweenRef` in MorphTransition). */
export const MORPH_REVERSE_CROSSFADE_MS = 500;

/** Plateau strength during forward cover (fragment shader `u_strength`). */
export const MORPH_STEADY_STRENGTH = 0.65;

/**
 * After new content is in the DOM, wait before capturing for reverse — same as HMR
 * soft-settle (`hmr-morph.ts` post-`resumeHmr` delay).
 */
export const MORPH_CAPTURE_SETTLE_MS = 200;

/** After `did-finish-load`, extra delay before capture (HMR full-reload path). */
export const MORPH_POST_LOAD_CAPTURE_DELAY_MS = 80;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;
