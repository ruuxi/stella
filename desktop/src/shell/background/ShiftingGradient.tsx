import { memo } from "react";
import { useTheme } from "@/context/theme-context";
import { cn } from "@/shared/lib/utils";

// Grain texture as data URI
const GRAIN_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27160%27%20height%3D%27160%27%20viewBox%3D%270%200%20160%20160%27%3E%3Cfilter%20id%3D%27n%27%3E%3CfeTurbulence%20type%3D%27fractalNoise%27%20baseFrequency%3D%270.8%27%20numOctaves%3D%274%27%20stitchTiles%3D%27stitch%27%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%27160%27%20height%3D%27160%27%20filter%3D%27url(%23n)%27%20opacity%3D%270.45%27%2F%3E%3C%2Fsvg%3E";

// Re-export types so existing imports don't break
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

export const ShiftingGradient = memo(function ShiftingGradient({
  className,
}: ShiftingGradientProps) {
  const { resolvedColorMode, colors } = useTheme();
  const isDark = resolvedColorMode === "dark";

  // Themes can provide an explicit gradient anchor for monochrome backgrounds
  const anchor = (colors as unknown as Record<string, string>).gradientAnchor;
  const c1 = anchor ?? colors.primary;
  const c2 = anchor ?? colors.interactive;
  const c3 = anchor ?? colors.success;

  // oklch interpolation produces smoother transitions in dark tones
  // where sRGB banding is most visible
  const mix = (color: string, pct: number) =>
    `color-mix(in oklch, ${color} ${pct}%, transparent)`;

  return (
    <div
      aria-hidden="true"
      className={cn("shifting-gradient", className)}
    >
      {/* CSS radial gradients with oklch interpolation to avoid dark-mode banding */}
      <div
        className="gradient-base"
        style={{
          background: [
            `radial-gradient(in oklch, circle at 18% 20%, ${mix(c1, 28)} 0%, ${mix(c1, 14)} 20%, transparent 42%)`,
            `radial-gradient(in oklch, circle at 84% 18%, ${mix(c2, 30)} 0%, ${mix(c2, 16)} 22%, transparent 44%)`,
            `radial-gradient(in oklch, circle at 50% 84%, ${mix(c3, 24)} 0%, ${mix(c3, 12)} 24%, transparent 50%)`,
            `var(--background)`,
          ].join(", "),
        }}
      />

      {/* Grain texture overlay — heavier in dark mode to dither residual banding */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 10 }}
      >
        <div
          className="gradient-grain"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URI}")`,
            opacity: isDark ? 0.28 : 0.14,
          }}
        />
      </div>
    </div>
  );
});
