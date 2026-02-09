import { useEffect, useState, useRef, useCallback, memo, type CSSProperties } from "react";
import { useTheme } from "../../theme/theme-context";
import { generateGradientTokens } from "../../theme/color";
import { cn } from "@/lib/utils";

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

// Base positions for 5 blobs (percentages)
const BASE_POSITIONS = [
  { x: 16, y: 14 },
  { x: 86, y: 16 },
  { x: 18, y: 88 },
  { x: 88, y: 88 },
  { x: 52, y: 54 },
];

// Grain texture as data URI
const GRAIN_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27160%27%20height%3D%27160%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%274%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27160%27%20height%3D%27160%27%20filter%3D%27url(%23n)%27%20opacity%3D%270.45%27%2F%3E%3C%2Fsvg%3E";

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Parse any color string to RGB using canvas
function parseColor(color: string): RGB | null {
  if (!color || color === "transparent") return null;

  // Try to use a canvas to parse the color
  if (typeof document !== "undefined") {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const data = ctx.getImageData(0, 0, 1, 1).data;
        return { r: data[0], g: data[1], b: data[2] };
      }
    } catch {
      // Fall through to computed style method
    }
  }

  return null;
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
  blurMultiplier = 1,
  sizeScale = 1
): Blob[] {
  // Crisp: sharp defined edges; Soft: dreamy blurred
  const blurRange = mode === "crisp" ? { min: 20, max: 40 } : { min: 120, max: 200 };

  return BASE_POSITIONS.map((base, i) => {
    const baseBlur = rand(blurRange.min, blurRange.max);
    return {
      x: rand(base.x - 6, base.x + 6),
      y: rand(base.y - 6, base.y + 6),
      size: Math.round(rand(1020, 1280) * sizeScale),
      scale: rand(0.9, 1.15),
      blur: Math.round(baseBlur * blurMultiplier),
      alpha: rand(0.75, 0.9),
      color: colors[i % colors.length],
    };
  });
}

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
}

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  blurMultiplier = 1,
  scale = 1,
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

    if (colorMode === "relative") {
      // Relative: subtle colors blended heavily with background
      // Uses derived tokens from OKLCH color scales (matching Aura)
      const tokenColors = [
        tokens.textInteractive,
        tokens.surfaceInfoStrong,
        tokens.surfaceSuccessStrong,
        tokens.surfaceWarningStrong,
        tokens.surfaceBrandBase,
      ];
      const strength = isDark ? 0.28 : 0.34;
      return tokenColors.map((token) => {
        const color = parseColor(token) ?? fallback;
        return mixRgb(bg, color, strength);
      });
    }

    // Strong: use brand/accent colors at high saturation
    const brandColor = parseColor(tokens.surfaceBrandBase) ?? parseColor(colors.primary) ?? fallback;
    const accentColor =
      parseColor(tokens.textInteractive) ??
      parseColor(colors.interactive) ??
      brandColor;
    const strength = isDark ? 0.45 : 0.55;

    return [
      mixRgb(bg, brandColor, strength),
      mixRgb(bg, accentColor, strength),
      mixRgb(bg, brandColor, strength * 0.85),
      mixRgb(bg, accentColor, strength * 0.88),
      mixRgb(bg, brandColor, strength * 0.9),
    ];
  }, [resolvedColorMode, colorMode, colors]);

  // Initialize and update blobs
  useEffect(() => {
    let cancelled = false;
    const timer = requestAnimationFrame(() => {
      if (cancelled) return;
      const palette = getPalette();
      setBlobs(generateBlobs(palette, mode, blurMultiplier, scale));
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
  }, [themeId, resolvedColorMode, mode, colorMode, getPalette, blurMultiplier, scale]);

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
        style={{ background: `var(--background)` }}
      />

      {/* Gradient blobs */}
      {blobs.map((blob, index) => (
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
            background: `radial-gradient(circle at center, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha}) 0%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.93}) 8%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.82}) 16%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.68}) 25%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.52}) 35%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.35}) 46%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.18}) 58%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha * 0.06}) 68%, transparent 78%)`,
          } as CSSProperties}
        />
      ))}

      {/* Backdrop blur to smooth banding */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 9,
          backdropFilter: 'blur(60px)',
          WebkitBackdropFilter: 'blur(60px)',
        }}
      />

      {/* Backdrop + Grain overlay (matching Aura) */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 10,
          backgroundColor: colors.background
            ? `color-mix(in srgb, ${colors.background} 35%, transparent)`
            : 'transparent',
        }}
      >
        <div
          className="gradient-grain"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URI}")`,
            opacity: mode === "soft" ? 0.28 : 0.55,
          }}
        />
      </div>
    </div>
  );
});
