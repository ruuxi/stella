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

const hasForcedLowPowerFlag = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("lowPower") === "1";
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Cheap heuristic for memory/CPU-constrained devices. Windows 8GB machines are
 * included because Stella's dev-server-style desktop stack is memory-bound
 * there even when CPU is mostly idle.
 */
export function isLowPowerDevice(): boolean {
  if (cachedLowPower !== undefined) return cachedLowPower;
  if (hasForcedLowPowerFlag()) {
    cachedLowPower = true;
    return true;
  }
  if (typeof navigator === "undefined") return false;

  const cores =
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 0;
  const memory =
    typeof (navigator as { deviceMemory?: number }).deviceMemory === "number"
      ? (navigator as { deviceMemory?: number }).deviceMemory!
      : 0;
  const platform =
    typeof navigator.platform === "string" ? navigator.platform : "";
  const userAgent =
    typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  const isWindows = /^Win/i.test(platform) || /\bWindows\b/i.test(userAgent);

  cachedLowPower =
    (cores > 0 && cores <= 4) ||
    (memory > 0 && memory <= 4) ||
    (isWindows && memory > 0 && memory <= 8);
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
