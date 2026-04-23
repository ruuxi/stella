/**
 * HMR / self-mod morph timing — overlay `MorphTransition` + `hmr-morph.ts` only.
 * (Onboarding demo morphs keep separate constants for isolation; values are aligned manually.)
 *
 * Design principle: the morph cover should fit *inside* the HMR/reload work
 * window, not extend it. Cosmetic timings are intentionally short — the
 * cover lifecycle should track the actual paint lifecycle as closely as
 * the renderer-paint signal allows. See `IPC_MORPH_RENDERER_PAINTED`.
 */

/** Reverse: `u_mix` 0→1 and strength →0 with cosine easing (matches `tweenRef` in MorphTransition).
 *  No forward-ramp constant: HMR-flavor cover snaps directly to steady
 *  state — the wind-up tween is too brief to register and just adds
 *  visual stutter. Onboarding still tweens (using its own constant). */
export const MORPH_REVERSE_CROSSFADE_MS = 180;

/** Plateau strength during forward cover (fragment shader `u_strength`). */
export const MORPH_STEADY_STRENGTH = 0.65;

/**
 * Fallback timeout for `waitForRendererPainted` on the soft-HMR path.
 * The renderer almost always signals well under this — `vite:afterUpdate`
 * + double-rAF typically resolves in 30–80ms. This is the wait we'll see
 * if the IPC signal is somehow missed (e.g., production build, crashed
 * renderer); kept short enough not to stall a healthy session.
 */
export const MORPH_SOFT_HMR_PAINT_FALLBACK_MS = 1000;

/**
 * Fallback timeout for `waitForRendererPainted` on the full-reload path.
 * Generous enough to cover a cold reload of the whole renderer process
 * (parse + execute + first paint), short enough that a wedged renderer
 * doesn't hold the cover up indefinitely.
 */
export const MORPH_FULL_RELOAD_PAINT_FALLBACK_MS = 3000;

export const MORPH_OVERLAY_READY_TIMEOUT_MS = 500;
export const MORPH_DONE_TIMEOUT_MS = 5000;
