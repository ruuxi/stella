import {
  memo,
  useEffect,
  useState,
  useRef,
  useCallback,
} from "react";
import { useTheme } from "@/context/theme-context";
import { cssToRgb } from "@/shared/lib/color";
import { generateGradientTokens } from "@/shared/theme/color";
import { cn } from "@/shared/lib/utils";

type RGB = { r: number; g: number; b: number };

interface Blob {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: RGB;
}

export type GradientMode = "soft" | "flat";
export type GradientColor = "relative" | "strong";

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;
  /** When true, fills the nearest positioned ancestor instead of the viewport (for sidebars, etc.). */
  contained?: boolean;
}

const BASE_POSITIONS = [
  { x: 0.16, y: 0.14 },
  { x: 0.86, y: 0.16 },
  { x: 0.18, y: 0.88 },
  { x: 0.88, y: 0.88 },
  { x: 0.52, y: 0.54 },
];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function parseColor(color: string): RGB | null {
  if (!color || color === "transparent") return null;

  try {
    const [r, g, b] = cssToRgb(color);
    return { r, g, b };
  } catch {
    return null;
  }
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r * (1 - t) + b.r * t),
    g: Math.round(a.g * (1 - t) + b.g * t),
    b: Math.round(a.b * (1 - t) + b.b * t),
  };
}

// ─── Blue noise dithering ───────────────────────────────────────────────
// 64x64 blue noise threshold map, generated from a void-and-cluster algorithm.
// We only need a small tile — it repeats seamlessly.
function generateBlueNoise(size: number): Float32Array {
  // Use a deterministic hash-based approach that approximates blue noise properties.
  // Each value is in [0, 1). The interleaved gradient noise (IGN) pattern
  // has excellent blue-noise-like spectral properties.
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Interleaved gradient noise (Jorge Jimenez, 2014)
      data[y * size + x] = (52.9829189 * ((0.06711056 * x + 0.00583715 * y) % 1)) % 1;
    }
  }
  return data;
}

const NOISE_SIZE = 64;
const blueNoise = generateBlueNoise(NOISE_SIZE);

// ─── Blob generation ────────────────────────────────────────────────────

function generateBlobs(colors: RGB[], mode: GradientMode = "soft"): Blob[] {
  if (mode === "flat") {
    // Single dominant color filling the entire canvas
    const color = colors[0];
    return [{ x: 0.5, y: 0.5, radius: 3, alpha: 0.5, color }];
  }

  return BASE_POSITIONS.map((base, index) => ({
    x: rand(base.x - 0.04, base.x + 0.04),
    y: rand(base.y - 0.04, base.y + 0.04),
    radius: rand(0.7, 0.95) * 0.65,
    alpha: rand(0.25, 0.4),
    color: colors[index % colors.length],
  }));
}

// ─── Canvas rendering ───────────────────────────────────────────────────
// Renders at RENDER_SCALE for performance; the browser's bilinear upscale
// provides additional free smoothing on top of the dithering.

const RENDER_SCALE = 0.6;

function renderGradient(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bg: RGB,
  blobs: Blob[],
  overlayAlpha: number,
) {
  const w = Math.round(width * RENDER_SCALE);
  const h = Math.round(height * RENDER_SCALE);

  if (w === 0 || h === 0) return;

  ctx.canvas.width = w;
  ctx.canvas.height = h;

  const imageData = ctx.createImageData(w, h);
  const pixels = imageData.data;
  const maxDim = Math.max(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Start with background color
      let r = bg.r;
      let g = bg.g;
      let b = bg.b;

      // Additively blend each blob
      for (let i = 0; i < blobs.length; i++) {
        const blob = blobs[i];
        const dx = x / w - blob.x;
        const dy = y / h - blob.y;
        // Use aspect-corrected distance
        const dist = Math.sqrt(dx * dx + dy * dy);
        const radius = blob.radius * (maxDim / w);

        if (dist >= radius) continue;

        // Smooth quintic falloff — no visible rings
        const t = dist / radius;
        const falloff = 1 - t * t * t * (t * (t * 6 - 15) + 10);
        const strength = falloff * blob.alpha;

        r = r + (blob.color.r - r) * strength;
        g = g + (blob.color.g - g) * strength;
        b = b + (blob.color.b - b) * strength;
      }

      // Semi-transparent overlay (matches the original's background wash)
      r = r + (bg.r - r) * overlayAlpha;
      g = g + (bg.g - g) * overlayAlpha;
      b = b + (bg.b - b) * overlayAlpha;

      // Blue noise dithering: ±0.5/255 jitter to break quantization bands
      const noise = blueNoise[(y % NOISE_SIZE) * NOISE_SIZE + (x % NOISE_SIZE)];
      const dither = (noise - 0.5) * (1.5 / 255);

      const idx = (y * w + x) * 4;
      pixels[idx] = Math.max(0, Math.min(255, Math.round(r + dither * 255)));
      pixels[idx + 1] = Math.max(0, Math.min(255, Math.round(g + dither * 255)));
      pixels[idx + 2] = Math.max(0, Math.min(255, Math.round(b + dither * 255)));
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ─── Component ──────────────────────────────────────────────────────────

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  lightweight = false,
  contained = false,
}: ShiftingGradientProps) {
  const { resolvedColorMode, theme, colors } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const blobsRef = useRef<Blob[]>([]);
  const prevKeyRef = useRef("");
  const [ready, setReady] = useState(false);

  const getPalette = useCallback((): RGB[] => {
    const isDark = resolvedColorMode === "dark";
    const fallback = { r: 120, g: 120, b: 120 };

    const tokens = generateGradientTokens(
      {
        primary: colors.primary,
        success: colors.success,
        warning: colors.warning,
        info: colors.info,
        interactive: colors.interactive,
      },
      isDark,
    );

    const bg = parseColor(colors.background) ?? { r: 248, g: 247, b: 247 };

    if (colorMode === "relative") {
      const tokenColors = [
        tokens.textInteractive,
        tokens.surfaceInfoStrong,
        tokens.surfaceSuccessStrong,
        tokens.surfaceWarningStrong,
        tokens.surfaceBrandBase,
      ];
      const strength = isDark ? 0.32 : 0.5;
      return tokenColors.map((token) => {
        const color = parseColor(token) ?? fallback;
        return mixRgb(bg, color, strength);
      });
    }

    const brandColor =
      parseColor(tokens.surfaceBrandBase) ?? parseColor(colors.primary) ?? fallback;
    const accentColor =
      parseColor(tokens.textInteractive) ??
      parseColor(colors.interactive) ??
      brandColor;
    const strength = isDark ? 0.55 : 0.85;

    return [
      mixRgb(bg, brandColor, strength),
      mixRgb(bg, accentColor, strength),
      mixRgb(bg, brandColor, strength * 0.85),
      mixRgb(bg, accentColor, strength * 0.88),
      mixRgb(bg, brandColor, strength * 0.9),
    ];
  }, [resolvedColorMode, colorMode, colors]);

  // Render to canvas when settings change
  useEffect(() => {
    if (lightweight) {
      prevKeyRef.current = "";
      return;
    }

    const key = `${theme.id}-${resolvedColorMode}-${mode}-${colorMode}`;
    const isFirstRender = !prevKeyRef.current;
    const settingsChanged = prevKeyRef.current !== key;

    if (!isFirstRender && !settingsChanged) {
      return;
    }

    prevKeyRef.current = key;

    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!ctxRef.current) {
      ctxRef.current = canvas.getContext("2d", { willReadFrequently: true });
    }
    const ctx = ctxRef.current;
    if (!ctx) return;

    const palette = getPalette();
    const blobs = generateBlobs(palette, mode);
    blobsRef.current = blobs;

    const bg = parseColor(colors.background) ?? { r: 248, g: 247, b: 247 };
    const rect = canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width ?? window.innerWidth;
    const h = rect?.height ?? window.innerHeight;

    renderGradient(ctx, w, h, bg, blobs, 0.25);

    if (isFirstRender) {
      requestAnimationFrame(() => setReady(true));
    }
  }, [theme.id, resolvedColorMode, mode, colorMode, getPalette, lightweight, colors]);

  // Re-render on resize
  useEffect(() => {
    if (lightweight) return;

    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const performResize = () => {
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      if (!canvas || !ctx || blobsRef.current.length === 0) return;

      const bg = parseColor(colors.background) ?? { r: 248, g: 247, b: 247 };
      const rect = canvas.parentElement?.getBoundingClientRect();
      const w = rect?.width ?? window.innerWidth;
      const h = rect?.height ?? window.innerHeight;

      renderGradient(ctx, w, h, bg, blobsRef.current, 0.25);
    };

    // Coalesce bursts of resize events. The canvas paint is a
    // per-pixel JS double-loop and is the dominant main-thread cost
    // when a sidebar that hosts this gradient (`contained`) animates
    // its width — every animation frame would otherwise trigger a
    // full repaint via ResizeObserver. Debouncing with a short idle
    // window means we keep the existing canvas (browser stretches it
    // visually via `width:100%`) during the slide and repaint once
    // after the size settles, which is imperceptible at typical
    // sidebar transition durations.
    const handleResize = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          performResize();
        });
      }, 120);
    };

    const cleanupTimers = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
    };

    if (contained) {
      const el = rootRef.current;
      if (!el || typeof ResizeObserver === "undefined") return;

      const ro = new ResizeObserver(() => {
        handleResize();
      });
      ro.observe(el);
      return () => {
        ro.disconnect();
        cleanupTimers();
      };
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      cleanupTimers();
    };
  }, [lightweight, colors, contained]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={cn(
        "shifting-gradient",
        contained && "shifting-gradient--contained",
        className,
      )}
    >
      {lightweight ? (
        <div
          className="gradient-base"
          style={{
            background: [
              `radial-gradient(circle at 18% 20%, color-mix(in srgb, ${colors.primary} 12%, transparent) 0%, transparent 30%)`,
              `radial-gradient(circle at 84% 18%, color-mix(in srgb, ${colors.interactive} 14%, transparent) 0%, transparent 32%)`,
              `radial-gradient(circle at 50% 84%, color-mix(in srgb, ${colors.success} 10%, transparent) 0%, transparent 40%)`,
              "var(--background)",
            ].join(", "),
          }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className="gradient-base"
          style={{
            imageRendering: "auto",
            opacity: ready ? 1 : 0,
            transition: ready ? "opacity 0.4s ease" : "none",
          }}
        />
      )}
    </div>
  );
});
