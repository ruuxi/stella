import {
  memo,
  useEffect,
  useState,
  useRef,
  useCallback,
  type CSSProperties,
} from "react";
import { useTheme } from "@/context/theme-context";
import { cssToRgb } from "@/shared/lib/color";
import { generateGradientTokens } from "@/shared/theme/color";
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

// Grain texture as data URI
const GRAIN_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27160%27%20height%3D%27160%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%274%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27160%27%20height%3D%27160%27%20filter%3D%27url(%23n)%27%20opacity%3D%270.45%27%2F%3E%3C%2Fsvg%3E";

export type GradientMode = "soft" | "crisp";
export type GradientColor = "relative" | "strong";

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;
}

const BASE_POSITIONS = [
  { x: 16, y: 14 },
  { x: 86, y: 16 },
  { x: 18, y: 88 },
  { x: 88, y: 88 },
  { x: 52, y: 54 },
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

function generateBlobs(
  colors: RGB[],
  mode: GradientMode = "soft",
  blurMultiplier = 1,
): Blob[] {
  const blurRange = mode === "crisp" ? { min: 20, max: 40 } : { min: 120, max: 200 };

  return BASE_POSITIONS.map((base, index) => {
    const baseBlur = rand(blurRange.min, blurRange.max);
    return {
      x: rand(base.x - 6, base.x + 6),
      y: rand(base.y - 6, base.y + 6),
      size: Math.round(rand(1020, 1280)),
      scale: rand(0.9, 1.15),
      blur: Math.round(baseBlur * blurMultiplier),
      alpha: rand(0.88, 1.0),
      color: colors[index % colors.length],
    };
  });
}

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
  mode = "soft",
  colorMode = "relative",
  blurMultiplier = 1,
  lightweight = false,
}: ShiftingGradientProps) {
  const { resolvedColorMode, themeId, colors } = useTheme();
  const [blobs, setBlobs] = useState<Blob[]>([]);
  const [ready, setReady] = useState(false);
  const prevKeyRef = useRef("");

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
      isDark,
    );

    if (colorMode === "relative") {
      const tokenColors = [
        tokens.textInteractive,
        tokens.surfaceInfoStrong,
        tokens.surfaceSuccessStrong,
        tokens.surfaceWarningStrong,
        tokens.surfaceBrandBase,
      ];
      const strength = isDark ? 0.35 : 0.4;
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
    const strength = isDark ? 0.65 : 0.75;

    return [
      mixRgb(bg, brandColor, strength),
      mixRgb(bg, accentColor, strength),
      mixRgb(bg, brandColor, strength * 0.85),
      mixRgb(bg, accentColor, strength * 0.88),
      mixRgb(bg, brandColor, strength * 0.9),
    ];
  }, [resolvedColorMode, colorMode, colors]);

  useEffect(() => {
    if (lightweight) {
      prevKeyRef.current = "";
      return;
    }

    const key = `${themeId}-${resolvedColorMode}-${mode}-${colorMode}`;
    const isFirstRender = !prevKeyRef.current;
    const settingsChanged = prevKeyRef.current !== key;

    if (!isFirstRender && !settingsChanged) {
      return;
    }

    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      const palette = getPalette();
      if (cancelled) return;
      setBlobs(generateBlobs(palette, mode, blurMultiplier));
      if (isFirstRender) {
        requestAnimationFrame(() => {
          if (!cancelled) {
            setReady(true);
          }
        });
      }
    });

    prevKeyRef.current = key;
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [
    themeId,
    resolvedColorMode,
    mode,
    colorMode,
    getPalette,
    blurMultiplier,
    lightweight,
  ]);

  return (
    <div aria-hidden="true" className={cn("shifting-gradient", className)}>
      <div
        className="gradient-base"
        style={{
          background: [
            lightweight
              ? `radial-gradient(circle at 18% 20%, color-mix(in srgb, ${colors.primary} 12%, transparent) 0%, transparent 30%)`
              : "none",
            lightweight
              ? `radial-gradient(circle at 84% 18%, color-mix(in srgb, ${colors.interactive} 14%, transparent) 0%, transparent 32%)`
              : "none",
            lightweight
              ? `radial-gradient(circle at 50% 84%, color-mix(in srgb, ${colors.success} 10%, transparent) 0%, transparent 40%)`
              : "none",
            "var(--background)",
          ]
            .filter((layer) => layer !== "none")
            .join(", "),
        }}
      />

      {!lightweight &&
        blobs.map((blob, index) => (
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
              background: `radial-gradient(circle at center, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${blob.alpha}) 0%, rgba(${blob.color.r}, ${blob.color.g}, ${blob.color.b}, ${Math.max(0, blob.alpha - 0.18)}) 26%, transparent 72%)`,
            } as CSSProperties}
          />
        ))}

      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 10,
          backgroundColor: lightweight
            ? `color-mix(in srgb, ${colors.background} 22%, transparent)`
            : `hsl(from var(--background) h s l / 0.25)`,
        }}
      >
        <div
          className="gradient-grain"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URI}")`,
            opacity: lightweight ? 0.14 : mode === "soft" ? 0.15 : 1,
          }}
        />
      </div>
    </div>
  );
});
