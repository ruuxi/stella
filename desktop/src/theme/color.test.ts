import { describe, expect, it } from "vitest";
import {
  hexToRgb,
  rgbToHex,
  rgbToOklch,
  oklchToRgb,
  hexToOklch,
  oklchToHex,
  generateScale,
  generateGradientTokens,
} from "./color";

describe("hexToRgb", () => {
  it("converts a 6-digit hex to normalized RGB", () => {
    const { r, g, b } = hexToRgb("#ff8000");
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0.502, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it("handles 3-digit shorthand hex", () => {
    const { r, g, b } = hexToRgb("#f00");
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it("handles hex without # prefix", () => {
    const { r, g, b } = hexToRgb("00ff00");
    expect(r).toBeCloseTo(0, 2);
    expect(g).toBeCloseTo(1, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it("returns fallback gray for empty string", () => {
    expect(hexToRgb("")).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("returns fallback gray for null/undefined-like input", () => {
    expect(hexToRgb(null as unknown as string)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(hexToRgb(undefined as unknown as string)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("returns fallback gray for non-hex string", () => {
    expect(hexToRgb("xyz")).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("converts black correctly", () => {
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("converts white correctly", () => {
    expect(hexToRgb("#ffffff")).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe("rgbToHex", () => {
  it("converts normalized RGB to hex", () => {
    expect(rgbToHex(1, 0, 0)).toBe("#ff0000");
    expect(rgbToHex(0, 1, 0)).toBe("#00ff00");
    expect(rgbToHex(0, 0, 1)).toBe("#0000ff");
  });

  it("clamps values above 1", () => {
    expect(rgbToHex(2, 0, 0)).toBe("#ff0000");
  });

  it("clamps values below 0", () => {
    expect(rgbToHex(-1, 0, 0)).toBe("#000000");
  });

  it("converts black", () => {
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
  });

  it("converts white", () => {
    expect(rgbToHex(1, 1, 1)).toBe("#ffffff");
  });
});

describe("rgbToOklch", () => {
  it("converts pure red to an OKLCH with hue near red", () => {
    const result = rgbToOklch(1, 0, 0);
    expect(result.l).toBeGreaterThan(0);
    expect(result.c).toBeGreaterThan(0);
    expect(result.h).toBeGreaterThanOrEqual(0);
    expect(result.h).toBeLessThan(360);
  });

  it("converts black to zero lightness", () => {
    const result = rgbToOklch(0, 0, 0);
    expect(result.l).toBeCloseTo(0, 4);
    expect(result.c).toBeCloseTo(0, 4);
  });

  it("converts white to full lightness with zero chroma", () => {
    const result = rgbToOklch(1, 1, 1);
    expect(result.l).toBeCloseTo(1, 2);
    expect(result.c).toBeCloseTo(0, 4);
  });

  it("ensures hue wraps to positive range", () => {
    // Blue channel dominant can produce negative atan2 which should be wrapped
    const result = rgbToOklch(0, 0, 1);
    expect(result.h).toBeGreaterThanOrEqual(0);
    expect(result.h).toBeLessThan(360);
  });
});

describe("oklchToRgb", () => {
  it("returns fallback gray for NaN inputs", () => {
    expect(oklchToRgb({ l: NaN, c: 0, h: 0 })).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(oklchToRgb({ l: 0.5, c: NaN, h: 0 })).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(oklchToRgb({ l: 0.5, c: 0, h: NaN })).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
  });

  it("converts black OKLCH back to black RGB", () => {
    const { r, g, b } = oklchToRgb({ l: 0, c: 0, h: 0 });
    expect(r).toBeCloseTo(0, 2);
    expect(g).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
  });

  it("converts white OKLCH back to white RGB", () => {
    const { r, g, b } = oklchToRgb({ l: 1, c: 0, h: 0 });
    expect(r).toBeCloseTo(1, 1);
    expect(g).toBeCloseTo(1, 1);
    expect(b).toBeCloseTo(1, 1);
  });

  it("clamps negative linear-sRGB values to 0", () => {
    // Extreme chroma with certain hues can produce negative intermediates
    const { r, g, b } = oklchToRgb({ l: 0.5, c: 0.4, h: 180 });
    expect(r).toBeGreaterThanOrEqual(0);
    expect(g).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  });
});

describe("round-trip conversions", () => {
  const testHexes = ["#ff0000", "#00ff00", "#0000ff", "#808080", "#1a2b3c"];

  for (const hex of testHexes) {
    it(`round-trips ${hex} through hex->oklch->hex`, () => {
      const oklch = hexToOklch(hex);
      const roundTripped = oklchToHex(oklch);
      // Allow minor rounding differences
      const orig = hexToRgb(hex);
      const back = hexToRgb(roundTripped);
      expect(back.r).toBeCloseTo(orig.r, 1);
      expect(back.g).toBeCloseTo(orig.g, 1);
      expect(back.b).toBeCloseTo(orig.b, 1);
    });
  }
});

describe("generateScale", () => {
  it("returns exactly 12 colors", () => {
    const scale = generateScale("#3b82f6", true);
    expect(scale).toHaveLength(12);
  });

  it("returns valid hex strings for dark mode", () => {
    const scale = generateScale("#3b82f6", true);
    for (const color of scale) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("returns valid hex strings for light mode", () => {
    const scale = generateScale("#3b82f6", false);
    for (const color of scale) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("produces different scales for dark vs light mode", () => {
    const dark = generateScale("#ff5500", true);
    const light = generateScale("#ff5500", false);
    // At least some steps should differ
    const differences = dark.filter((c, i) => c !== light[i]);
    expect(differences.length).toBeGreaterThan(0);
  });
});

describe("generateGradientTokens", () => {
  const seeds = {
    primary: "#3b82f6",
    success: "#22c55e",
    warning: "#eab308",
    info: "#06b6d4",
    interactive: "#8b5cf6",
  };

  it("returns all expected token keys for dark mode", () => {
    const tokens = generateGradientTokens(seeds, true);
    expect(tokens).toHaveProperty("textInteractive");
    expect(tokens).toHaveProperty("surfaceInfoStrong");
    expect(tokens).toHaveProperty("surfaceSuccessStrong");
    expect(tokens).toHaveProperty("surfaceWarningStrong");
    expect(tokens).toHaveProperty("surfaceBrandBase");
  });

  it("returns valid hex values", () => {
    const tokens = generateGradientTokens(seeds, false);
    for (const value of Object.values(tokens)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("produces different tokens for dark vs light", () => {
    const dark = generateGradientTokens(seeds, true);
    const light = generateGradientTokens(seeds, false);
    // textInteractive uses different scale indices
    expect(dark.textInteractive).not.toBe(light.textInteractive);
  });
});
