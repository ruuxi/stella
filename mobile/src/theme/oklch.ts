/**
 * OKLCH color utilities — ported from desktop/src/shared/theme/color.ts
 * Uses OKLCH color space for perceptually uniform color manipulation.
 */

export interface OklchColor {
  l: number; // Lightness 0-1
  c: number; // Chroma 0-0.4+
  h: number; // Hue 0-360
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (!hex) return { r: 0.5, g: 0.5, b: 0.5 };
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return { r: 0.5, g: 0.5, b: 0.5 };
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    return Math.round(clamped * 255).toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToOklch(r: number, g: number, b: number): OklchColor {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.sqrt(a * a + bOk * bOk);
  let H = Math.atan2(bOk, a) * (180 / Math.PI);
  if (H < 0) H += 360;

  return { l: L, c: C, h: H };
}

export function oklchToRgb(oklch: OklchColor): { r: number; g: number; b: number } {
  const { l: L, c: C, h: H } = oklch;
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);

  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;

  return {
    r: linearToSrgb(Math.max(0, l * l * l)),
    g: linearToSrgb(Math.max(0, m * m * m)),
    b: linearToSrgb(Math.max(0, s * s * s)),
  };
}

export function hexToOklch(hex: string): OklchColor {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklch(r, g, b);
}

export function oklchToHex(oklch: OklchColor): string {
  const { r, g, b } = oklchToRgb(oklch);
  return rgbToHex(r, g, b);
}

/** Generate a 12-step color scale from a seed color (matches Aura design system). */
export function generateScale(seed: string, isDark: boolean): string[] {
  const base = hexToOklch(seed);
  const scale: string[] = [];

  const lightSteps = isDark
    ? [0.15, 0.18, 0.22, 0.26, 0.32, 0.38, 0.46, 0.56, base.l, base.l - 0.05, 0.75, 0.93]
    : [0.99, 0.97, 0.94, 0.9, 0.85, 0.79, 0.72, 0.64, base.l, base.l + 0.05, 0.45, 0.25];

  const chromaMultipliers = isDark
    ? [0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1, 1, 0.9, 0.6]
    : [0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1, 1, 0.95, 0.85];

  for (let i = 0; i < 12; i++) {
    scale.push(oklchToHex({ l: lightSteps[i], c: base.c * chromaMultipliers[i], h: base.h }));
  }
  return scale;
}

// ---------------------------------------------------------------------------
// Derivation helpers for the mobile Colors type
// ---------------------------------------------------------------------------

/** Blend a hex color toward the background at a given strength (0 = bg, 1 = color). */
export function blendToward(hex: string, bg: string, strength: number): string {
  const c = hexToOklch(hex);
  const b = hexToOklch(bg);
  return oklchToHex({
    l: b.l + (c.l - b.l) * strength,
    c: b.c + (c.c - b.c) * strength,
    h: c.c > 0.001 ? c.h : b.h,
  });
}

/** Darken or lighten a hex color in OKLCH space. */
export function adjustLightness(hex: string, delta: number): string {
  const c = hexToOklch(hex);
  return oklchToHex({ l: Math.max(0, Math.min(1, c.l + delta)), c: c.c, h: c.h });
}

/** Create a soft/muted version of a color (reduce chroma, blend toward background). */
export function soften(hex: string, bg: string, alpha: number): string {
  return blendToward(hex, bg, alpha);
}

/** Fade a hex color by reducing its lightness toward 50% gray. Returns hex with alpha suffix. */
export function fadeHex(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255).toString(16).padStart(2, "0");
  // Ensure hex is 6-char (strip existing alpha if 8-char)
  const clean = hex.replace("#", "").slice(0, 6);
  return `#${clean}${alpha}`;
}
