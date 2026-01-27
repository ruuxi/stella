// Color utilities ported from Aura
// Uses OKLCH color space for perceptually uniform color scales

export type HexColor = string;

export interface OklchColor {
  l: number; // Lightness 0-1
  c: number; // Chroma 0-0.4+
  h: number; // Hue 0-360
}

export function hexToRgb(hex: HexColor): { r: number; g: number; b: number } {
  if (!hex || typeof hex !== "string") {
    return { r: 0.5, g: 0.5, b: 0.5 };
  }

  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;

  const num = parseInt(full, 16);
  if (Number.isNaN(num)) {
    return { r: 0.5, g: 0.5, b: 0.5 };
  }

  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

export function rgbToHex(r: number, g: number, b: number): HexColor {
  const toHex = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    const int = Math.round(clamped * 255);
    return int.toString(16).padStart(2, "0");
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

  // Handle edge cases
  if (Number.isNaN(L) || Number.isNaN(C) || Number.isNaN(H)) {
    return { r: 0.5, g: 0.5, b: 0.5 };
  }

  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);

  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  const lr = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return {
    r: linearToSrgb(Math.max(0, lr)),
    g: linearToSrgb(Math.max(0, lg)),
    b: linearToSrgb(Math.max(0, lb)),
  };
}

export function hexToOklch(hex: HexColor): OklchColor {
  const { r, g, b } = hexToRgb(hex);
  return rgbToOklch(r, g, b);
}

export function oklchToHex(oklch: OklchColor): HexColor {
  const { r, g, b } = oklchToRgb(oklch);
  return rgbToHex(r, g, b);
}

/**
 * Generate a 12-step color scale from a seed color.
 * This matches Aura's scale generation for consistent gradients.
 */
export function generateScale(seed: HexColor, isDark: boolean): HexColor[] {
  const base = hexToOklch(seed);
  const scale: HexColor[] = [];

  const lightSteps = isDark
    ? [0.15, 0.18, 0.22, 0.26, 0.32, 0.38, 0.46, 0.56, base.l, base.l - 0.05, 0.75, 0.93]
    : [0.99, 0.97, 0.94, 0.9, 0.85, 0.79, 0.72, 0.64, base.l, base.l + 0.05, 0.45, 0.25];

  const chromaMultipliers = isDark
    ? [0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1, 1, 0.9, 0.6]
    : [0.1, 0.15, 0.25, 0.35, 0.45, 0.55, 0.7, 0.85, 1, 1, 0.95, 0.85];

  for (let i = 0; i < 12; i++) {
    scale.push(
      oklchToHex({
        l: lightSteps[i],
        c: base.c * chromaMultipliers[i],
        h: base.h,
      })
    );
  }

  return scale;
}

/**
 * Generate derived gradient tokens from theme seed colors.
 * Matches Aura's token generation for consistent gradient appearance.
 */
export function generateGradientTokens(
  seeds: {
    primary: string;
    success: string;
    warning: string;
    info: string;
    interactive: string;
  },
  isDark: boolean
): {
  textInteractive: string;
  surfaceInfoStrong: string;
  surfaceSuccessStrong: string;
  surfaceWarningStrong: string;
  surfaceBrandBase: string;
} {
  const interactive = generateScale(seeds.interactive, isDark);
  const info = generateScale(seeds.info, isDark);
  const success = generateScale(seeds.success, isDark);
  const warning = generateScale(seeds.warning, isDark);
  const primary = generateScale(seeds.primary, isDark);

  return {
    textInteractive: interactive[isDark ? 10 : 8],
    surfaceInfoStrong: info[8],
    surfaceSuccessStrong: success[8],
    surfaceWarningStrong: warning[8],
    surfaceBrandBase: primary[8],
  };
}
