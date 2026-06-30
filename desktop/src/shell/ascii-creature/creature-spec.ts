import { buildGlyphAtlas, getCssNumber } from "./glyph-atlas";

/**
 * Extra canvas space around the creature so edge effects (speaking
 * expansion, breathing, flash wave) are never clipped. The shader UV
 * mapping is scaled by the same factor so the creature stays the same
 * pixel size.
 */
export const EDGE_SCALE = 2.5;

const DEFAULT_FONT_FAMILY =
  '"SF Mono", "Menlo", "Monaco", "Courier New", monospace';

/**
 * Fully-resolved, context-independent description of a creature canvas:
 * its pixel/backing geometry, shader grid, glyph atlas, and a `key` that
 * uniquely identifies a reusable GL renderer. Two `StellaAnimation`
 * mounts that resolve to the same `key` (same font metrics + size + dpr)
 * can share — and therefore pool — a single WebGL context + program.
 */
export type CreatureSpec = {
  key: string;
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  gridWidth: number;
  gridHeight: number;
  glyphAtlas: HTMLCanvasElement;
};

export type CreatureSpecOptions = {
  width: number;
  height: number;
  maxDpr?: number;
};

/**
 * Measure the creature geometry from a mounted `.stella-animation-container`
 * (reads its `--ascii-*` custom properties + the platform mono font) and
 * derive the canvas/backing/grid sizes + cache key. Pure aside from the
 * font measurement; returns `null` only when a 2D measuring context or the
 * glyph atlas can't be created.
 */
export function resolveCreatureSpec(
  container: HTMLElement,
  { width, height, maxDpr }: CreatureSpecOptions,
): CreatureSpec | null {
  const styles = getComputedStyle(container);
  const fontSize = getCssNumber(
    styles.getPropertyValue("--ascii-font-size"),
    11,
  );
  const lineHeight = getCssNumber(
    styles.getPropertyValue("--ascii-line-height"),
    fontSize,
  );
  const fontFamily =
    styles.getPropertyValue("--ascii-font-family").trim() ||
    DEFAULT_FONT_FAMILY;

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) return null;
  measureCtx.font = `${fontSize}px ${fontFamily}`;
  const glyphWidth = Math.max(1, Math.ceil(measureCtx.measureText("M").width));
  const glyphHeight = Math.max(1, Math.ceil(lineHeight));

  const cssWidth = Math.max(1, Math.floor(width * glyphWidth * EDGE_SCALE));
  const cssHeight = Math.max(1, Math.floor(height * glyphHeight * EDGE_SCALE));
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr ?? Infinity);
  const backingWidth = Math.floor(cssWidth * dpr);
  const backingHeight = Math.floor(cssHeight * dpr);

  const glyphAtlas = buildGlyphAtlas(
    fontFamily,
    fontSize,
    glyphWidth,
    glyphHeight,
  );
  if (!glyphAtlas) return null;

  const gridWidth = width * EDGE_SCALE;
  const gridHeight = height * EDGE_SCALE;
  const key = `${fontFamily}|${fontSize}|${lineHeight}|${backingWidth}x${backingHeight}|${gridWidth}x${gridHeight}`;

  return {
    key,
    cssWidth,
    cssHeight,
    backingWidth,
    backingHeight,
    gridWidth,
    gridHeight,
    glyphAtlas,
  };
}
