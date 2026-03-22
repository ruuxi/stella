import { useEffect, useState, useRef, useCallback, memo, type CSSProperties } from "react";
import { useTheme } from "@/context/theme-context";
import { generateGradientTokens } from "@/shared/theme/color";
import { cssToRgb } from "@/shared/lib/color";
import { cn } from "@/shared/lib/utils";

type RGB = { r: number; g: number; b: number };

interface Blob {
  x: number;
  y: number;
  size: number;
  scale: number;
  blur: number;
  alpha: number;
  color: RGB;
}

// Gradient mode controls blur
export type GradientMode = "soft" | "crisp";
// Gradient color controls saturation/strength
export type GradientColor = "relative" | "strong";

// Base positions for 5 blobs (percentages) — asymmetric to avoid visible pattern
const BASE_POSITIONS = [
  { x: 14, y: 18 },
  { x: 82, y: 12 },
  { x: 22, y: 84 },
  { x: 85, y: 80 },
  { x: 48, y: 48 },
];

// Grain texture as data URI
const GRAIN_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27160%27%20height%3D%27160%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%274%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27160%27%20height%3D%27160%27%20filter%3D%27url(%23n)%27%20opacity%3D%270.45%27%2F%3E%3C%2Fsvg%3E";

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

function generateBlobs(
  colors: RGB[],
  mode: GradientMode = "soft",
  colorMode: GradientColor = "relative",
  blurMultiplier = 1,
  sizeScale = 1
): Blob[] {
  // Crisp: defined color zones with moderate softening; Soft: dreamy atmospheric wash
  const blurRange = mode === "crisp" ? { min: 50, max: 80 } : { min: 120, max: 200 };
  // Subtle mode uses lower alpha so blobs tint rather than dominate
  const alphaRange = colorMode === "relative"
    ? { min: 0.45, max: 0.62 }
    : { min: 0.60, max: 0.78 };
  // Large enough that adjacent blobs' gradient tails overlap and merge
  const sizeRange = { min: 1100, max: 1500 };

  return BASE_POSITIONS.map((base, i) => {
    const baseBlur = rand(blurRange.min, blurRange.max);
    return {
      // ±10% jitter breaks the visible grid pattern
      x: rand(base.x - 10, base.x + 10),
      y: rand(base.y - 10, base.y + 10),
      size: Math.round(rand(sizeRange.min, sizeRange.max) * sizeScale),
      scale: rand(0.85, 1.2),
      blur: Math.round(baseBlur * blurMultiplier),
      alpha: rand(alphaRange.min, alphaRange.max),
      color: colors[i % colors.length],
    };
  });
}

/** Build a radial gradient string with a wide, gaussian-like falloff.
 *  Color extends all the way to the blob edge so adjacent blobs merge. */
function blobGradient(r: number, g: number, b: number, a: number): string {
  // Gentle gaussian-inspired curve: maintains meaningful color across ~70% of
  // the radius, then tapers smoothly to transparent. The per-blob CSS blur
  // filter already softens edges, so we don't need an aggressive cutoff.
  const stops = [
    [0, 1.0],
    [14, 0.88],
    [28, 0.72],
    [42, 0.54],
    [55, 0.38],
    [67, 0.24],
    [78, 0.13],
    [88, 0.05],
    [100, 0],
  ] as const;
  return `radial-gradient(circle at center, ${stops
    .map(([pct, mult]) =>
      mult === 0
        ? `transparent ${pct}%`
        : `rgba(${r}, ${g}, ${b}, ${(a * mult).toFixed(3)}) ${pct}%`
    )
    .join(", ")})`;
}

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;
}

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  blurMultiplier = 1,
  scale = 1,
  lightweight = false,
}: ShiftingGradientProps) {
  const { resolvedColorMode, themeId, colors } = useTheme();
  const [blobs, setBlobs] = useState<Blob[]>([]);
  const [ready, setReady] = useState(false);
  const didInitRef = useRef(false);

  // Generate palette directly from theme colors to avoid timing issues
  const getPalette = useCallback((): RGB[] => {
    const isDark = resolvedColorMode === "dark";

    const bg = parseColor(colors.background) ?? { r: 248, g: 247, b: 247 };
    const fallback = { r: 120, g: 120, b: 120 };

    const tokens = generateGradientTokens(
      {
        primary: colors.primary,
        success: colors.success,
        warning: colors.warning,
        info: colors.info,
        interactive: colors.interactive,
      },
      isDark
    );

    // All blobs share the brand hue — differentiation comes from lightness,
    // not hue. This creates depth (like light across a surface) instead of
    // a rainbow.
    const anchor = parseColor(tokens.surfaceBrandBase) ?? parseColor(colors.primary) ?? fallback;
    const white: RGB = { r: 255, g: 255, b: 255 };
    const black: RGB = { r: 0, g: 0, b: 0 };

    // Per-blob lightness offsets: positive = lighter, negative = darker
    const lightnessShifts = [0.0, 0.14, -0.10, 0.08, -0.05];

    const contrastBlobs = lightnessShifts.map((shift) => {
      if (shift > 0) return mixRgb(anchor, white, shift);
      if (shift < 0) return mixRgb(anchor, black, -shift);
      return anchor;
    });

    if (colorMode === "relative") {
      const strength = isDark ? 0.30 : 0.40;
      return contrastBlobs.map((color) => mixRgb(bg, color, strength));
    }

    // Vivid: stronger presence, same lightness-based variation
    const strength = isDark ? 0.50 : 0.58;
    const strengthVariation = [1.0, 0.92, 0.88, 0.95, 0.85];
    return contrastBlobs.map((color, i) => mixRgb(bg, color, strength * strengthVariation[i]));
  }, [resolvedColorMode, colorMode, colors]);

  // Initialize and update blobs
  useEffect(() => {
    if (lightweight) {
      setBlobs([]);
      setReady(false);
      didInitRef.current = false;
      return;
    }

    let cancelled = false;
    const timer = requestAnimationFrame(() => {
      if (cancelled) return;
      const palette = getPalette();
      setBlobs(generateBlobs(palette, mode, colorMode, blurMultiplier, scale));
      if (!didInitRef.current) {
        didInitRef.current = true;
        requestAnimationFrame(() => {
          if (!cancelled) {
            setReady(true);
          }
        });
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(timer);
    };
  }, [themeId, resolvedColorMode, mode, colorMode, getPalette, blurMultiplier, scale, lightweight]);

  // Periodically shift blob positions
  //useEffect(() => {
  //  const interval = setInterval(() => {
  //    const palette = getPalette();
  //    setBlobs(generateBlobs(palette, mode, blurMultiplier));
  //  }, 8000);
//
  //  return () => clearInterval(interval);
  //}, [getPalette, mode, blurMultiplier]);

  return (
    <div
      aria-hidden="true"
      className={cn("shifting-gradient", className)}
    >
      {/* Base background layer */}
      <div
        className="gradient-base"
        style={{
          background: lightweight
            ? `radial-gradient(circle at 18% 20%, color-mix(in srgb, ${colors.primary} 12%, transparent) 0%, transparent 30%), radial-gradient(circle at 84% 18%, color-mix(in srgb, ${colors.interactive} 14%, transparent) 0%, transparent 32%), radial-gradient(circle at 50% 84%, color-mix(in srgb, ${colors.success} 10%, transparent) 0%, transparent 40%), var(--background)`
            : `var(--background)`,
        }}
      />

      {/* Gradient blobs */}
      {lightweight
        ? null
        : blobs.map((blob, index) => (
        <div
          key={index}
          className="gradient-blob"
          style={{
            width: `${blob.size}px`,
            height: `${blob.size}px`,
            left: `${blob.x}%`,
            top: `${blob.y}%`,
            transform: `translate3d(-50%, -50%, 0) scale(${blob.scale})`,
            transition: ready
              ? "left 1000ms cubic-bezier(0.22, 1, 0.36, 1), top 3200ms cubic-bezier(0.22, 1, 0.36, 1), transform 1000ms cubic-bezier(0.22, 1, 0.36, 1), filter 500ms ease"
              : "none",
            willChange: "left, top, transform",
            filter: `blur(${blob.blur}px)`,
            borderRadius: "9999px",
            background: blobGradient(blob.color.r, blob.color.g, blob.color.b, blob.alpha),
          } as CSSProperties}
        />
          ))}

      {/* Backdrop blur — tuned per mode to preserve character */}
      {lightweight ? null : (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            zIndex: 9,
            // Soft: heavy blur compounds with blob blur for dreamy wash
            // Crisp: moderate blur merges blob edges while keeping color zones distinct
            backdropFilter: mode === "crisp" ? 'blur(34px)' : 'blur(60px)',
            WebkitBackdropFilter: mode === "crisp" ? 'blur(34px)' : 'blur(60px)',
          }}
        />
      )}

      {/* Background veil + grain texture overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 10,
          // Soft: heavier veil for ethereal feel; Crisp: lighter veil to let colors punch through
          backgroundColor: colors.background
            ? `color-mix(in srgb, ${colors.background} ${lightweight ? 22 : mode === "crisp" ? 28 : 38}%, transparent)`
            : 'transparent',
        }}
      >
        <div
          className="gradient-grain"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URI}")`,
            // Soft: subtle organic texture; Crisp: moderate grain for definition, not noise
            opacity: lightweight ? 0.14 : mode === "soft" ? 0.22 : 0.35,
          }}
        />
      </div>
    </div>
  );
});
