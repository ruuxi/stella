/**
 * Shared CSS color parsing utility.
 *
 * Converts any CSS color string (hex, rgb, oklch, named colors, etc.)
 * to numeric RGB values. Uses regex fast paths for hex/rgb and falls
 * back to a cached canvas for complex formats like oklch.
 */

// ---- Internal helpers ----

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(color: string): Uint8ClampedArray | null {
  if (!color.startsWith("#")) return null;
  const hex = color.slice(1).trim();
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) : 255;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return new Uint8ClampedArray([r, g, b, a]);
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return new Uint8ClampedArray([r, g, b, a]);
  }
  return null;
}

function parseRgbToken(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  if (t.endsWith("%")) {
    const pct = Number.parseFloat(t.slice(0, -1));
    if (!Number.isFinite(pct)) return null;
    return clampByte((pct / 100) * 255);
  }
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return clampByte(n);
}

function parseAlphaToken(token: string | undefined): number {
  if (!token) return 255;
  const t = token.trim();
  if (t.endsWith("%")) {
    const pct = Number.parseFloat(t.slice(0, -1));
    if (!Number.isFinite(pct)) return 255;
    return clampByte((pct / 100) * 255);
  }
  const n = Number.parseFloat(t);
  if (!Number.isFinite(n)) return 255;
  return clampByte(n <= 1 ? n * 255 : n);
}

function parseRgbColor(color: string): Uint8ClampedArray | null {
  const match = color.trim().match(/^rgba?\((.+)\)$/i);
  if (!match) return null;
  const body = match[1].replace(/\s*\/\s*/g, ",");
  const parts = body.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const r = parseRgbToken(parts[0]);
  const g = parseRgbToken(parts[1]);
  const b = parseRgbToken(parts[2]);
  if (r === null || g === null || b === null) return null;
  return new Uint8ClampedArray([r, g, b, parseAlphaToken(parts[3])]);
}

// Cached canvas context — allocated once, reused for all calls.
let _colorCtx: CanvasRenderingContext2D | null | undefined;

function getColorCtx(): CanvasRenderingContext2D | null {
  if (_colorCtx !== undefined) return _colorCtx;
  if (typeof document === "undefined") {
    _colorCtx = null;
    return _colorCtx;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  _colorCtx = canvas.getContext("2d", { willReadFrequently: true });
  return _colorCtx;
}

/**
 * Parse any CSS color string to RGBA bytes.
 * Tries hex/rgb regex first, falls back to canvas for oklch etc.
 */
function sampleColor(color: string): Uint8ClampedArray {
  const parsed = parseHexColor(color) ?? parseRgbColor(color);
  if (parsed) return parsed;

  const ctx = getColorCtx();
  if (!ctx) return new Uint8ClampedArray([0, 0, 0, 255]);

  try {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data;
  } catch {
    return new Uint8ClampedArray([0, 0, 0, 255]);
  }
}

// ---- Public API ----

/** CSS color string → [r, g, b] in 0–255 range. */
export function cssToRgb(color: string): [number, number, number] {
  const d = sampleColor(color);
  return [d[0], d[1], d[2]];
}

/** CSS color string → [r, g, b] in 0–1 range (for WebGL uniforms). */
export function cssToVec3(color: string): [number, number, number] {
  const d = sampleColor(color);
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
