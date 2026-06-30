import { initRenderer } from "./renderer";
import {
  resolveCreatureSpec,
  type CreatureSpec,
  type CreatureSpecOptions,
} from "./creature-spec";

/**
 * Persistent pool of WebGL creature renderers.
 *
 * Creating a renderer is expensive and synchronous on the main thread:
 * `getContext('webgl')` allocates a GPU context and `createProgram`
 * compiles + links the (large) creature shaders — profiled at ~16-20ms per
 * mount on an M4 (ANGLE/Metal), and ~200ms the very first time. The chat
 * working indicator mounts/unmounts that on every single message send, so
 * the cost lands as a dropped frame exactly when the indicator appears.
 *
 * This pool keeps the canvas + GL context + compiled program alive across
 * React mount/unmount cycles, keyed by `CreatureSpec.key` (font metrics +
 * backing size + grid). `StellaAnimation` borrows an entry on mount and
 * returns it on unmount instead of tearing the context down, so every
 * appearance after the first is effectively free. The component's
 * lifecycle, visuals, and animation are unchanged — only the GL spin-up is
 * amortized.
 */
type GlRenderer = NonNullable<ReturnType<typeof initRenderer>>;

export type PooledCreatureRenderer = {
  key: string;
  canvas: HTMLCanvasElement;
  renderer: GlRenderer;
};

const idleByKey = new Map<string, PooledCreatureRenderer[]>();
/** Keep at most this many warm renderers per key (covers a couple of
 *  surfaces showing the same-size creature at once). */
const MAX_IDLE_PER_KEY = 2;

/** Neutral colors for a pre-warmed renderer; real colors are applied via
 *  `setColors` the moment it is acquired. */
const PREWARM_COLORS = new Float32Array([
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
]);

function isContextLost(canvas: HTMLCanvasElement): boolean {
  const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
  return !gl || gl.isContextLost();
}

function disposeEntry(entry: PooledCreatureRenderer): void {
  entry.renderer.destroy();
  (entry.canvas.getContext("webgl") as WebGLRenderingContext | null)
    ?.getExtension("WEBGL_lose_context")
    ?.loseContext();
}

function createEntry(
  spec: CreatureSpec,
  colors: Float32Array,
  birth: number,
  flash: number,
): PooledCreatureRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.className = "ascii-canvas";
  canvas.style.width = `${spec.cssWidth}px`;
  canvas.style.height = `${spec.cssHeight}px`;
  canvas.width = spec.backingWidth;
  canvas.height = spec.backingHeight;
  const renderer = initRenderer(
    canvas,
    spec.glyphAtlas,
    spec.gridWidth,
    spec.gridHeight,
    colors,
    birth,
    flash,
  );
  if (!renderer) return null;
  return { key: spec.key, canvas, renderer };
}

/**
 * Borrow a warm renderer for `spec` (reusing a pooled one when available,
 * else creating it). The caller owns attaching `entry.canvas` into the DOM
 * and must hand the entry back to `releaseCreatureRenderer` on unmount.
 */
export function acquireCreatureRenderer(
  spec: CreatureSpec,
  colors: Float32Array,
  birth: number,
  flash: number,
): PooledCreatureRenderer | null {
  const pool = idleByKey.get(spec.key);
  while (pool && pool.length > 0) {
    const entry = pool.pop()!;
    if (!isContextLost(entry.canvas)) {
      entry.renderer.setColors(colors);
      return entry;
    }
    // Context was reclaimed by the browser while idle — drop and try next.
    entry.renderer.destroy();
  }
  return createEntry(spec, colors, birth, flash);
}

/** Return a renderer to the pool (warm) instead of destroying its GL
 *  context. Detaches the canvas; over the per-key cap the entry is fully
 *  disposed so idle GPU memory stays bounded. */
export function releaseCreatureRenderer(entry: PooledCreatureRenderer): void {
  entry.canvas.parentNode?.removeChild(entry.canvas);
  if (isContextLost(entry.canvas)) {
    entry.renderer.destroy();
    return;
  }
  const pool = idleByKey.get(entry.key) ?? [];
  if (pool.length >= MAX_IDLE_PER_KEY) {
    disposeEntry(entry);
    return;
  }
  pool.push(entry);
  idleByKey.set(entry.key, pool);
}

/** Create one warm renderer for `spec` ahead of first use (no-op if one is
 *  already pooled). */
export function prewarmCreatureRenderer(spec: CreatureSpec): void {
  const existing = idleByKey.get(spec.key);
  if (existing && existing.length > 0) return;
  const entry = createEntry(spec, PREWARM_COLORS, 1, 0);
  if (!entry) return;
  const pool = idleByKey.get(spec.key) ?? [];
  pool.push(entry);
  idleByKey.set(spec.key, pool);
}

/**
 * Best-effort idle pre-warm: measure the creature geometry for `options`
 * against a throwaway hidden container and build one pooled renderer, so
 * the first real mount (e.g. the working indicator on the first message
 * send) reuses it instead of paying the cold ~200ms GL spin-up on the
 * main thread. Safe to call repeatedly; never throws into the caller.
 */
export function prewarmCreature(options: CreatureSpecOptions): void {
  if (typeof document === "undefined" || !document.body) return;
  let container: HTMLDivElement | null = null;
  try {
    container = document.createElement("div");
    container.className =
      "stella-animation-container stella-animation-container--paused";
    container.style.cssText =
      "position:absolute;left:-9999px;top:0;width:24px;height:24px;visibility:hidden;pointer-events:none";
    document.body.appendChild(container);
    const spec = resolveCreatureSpec(container, options);
    if (spec) prewarmCreatureRenderer(spec);
  } catch {
    // Pre-warming is a pure optimization — swallow any failure.
  } finally {
    container?.parentNode?.removeChild(container);
  }
}
