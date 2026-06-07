/**
 * Client-side device capability checks for scaling back GPU/CPU-heavy decorative
 * effects (blur entrances, infinite marketing-style loops, backdrop-filter glass)
 * on low-end machines.
 *
 * The inline `stella-boot.js` script mirrors `isLowPowerDevice()` so
 * `html[data-low-power]` is present before first paint; this module is the
 * TypeScript source of truth for components that need the same signal later.
 */

let cachedLowPower: boolean | undefined;

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Cheap heuristic for memory/CPU-constrained devices. Conservative: 8-core /
 * 8GB+ machines keep the full experience.
 */
export function isLowPowerDevice(): boolean {
  if (cachedLowPower !== undefined) return cachedLowPower;
  if (typeof navigator === "undefined") return false;

  const cores =
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 0;
  const memory =
    typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as { deviceMemory?: number }).deviceMemory!
      : 0;

  cachedLowPower =
    (cores > 0 && cores <= 4) || (memory > 0 && memory <= 4);
  return cachedLowPower;
}

export function shouldUseLowPowerEffects(): boolean {
  return prefersReducedMotion() || isLowPowerDevice();
}

/** Sync `data-low-power` when boot script could not run (tests, dev HMR). */
export function applyLowPowerDocumentFlag(): void {
  if (typeof document === "undefined") return;
  if (shouldUseLowPowerEffects()) {
    document.documentElement.dataset.lowPower = "true";
  } else {
    delete document.documentElement.dataset.lowPower;
  }
}
