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
  const { colors } = useTheme();

  // Themes can provide an explicit gradient anchor for monochrome backgrounds
  const anchor = (colors as unknown as Record<string, string>).gradientAnchor;
  const c1 = anchor ?? colors.primary;
  const c2 = anchor ?? colors.interactive;
  const c3 = anchor ?? colors.success;

  return (
    <div
      aria-hidden="true"
      className={cn("shifting-gradient", className)}
    >
      {/* Subtle CSS radial gradients — no blobs, no JS animation */}
      <div
        className="gradient-base"
        style={{
          background: `radial-gradient(circle at 18% 20%, color-mix(in srgb, ${c1} 12%, transparent) 0%, transparent 30%), radial-gradient(circle at 84% 18%, color-mix(in srgb, ${c2} 14%, transparent) 0%, transparent 32%), radial-gradient(circle at 50% 84%, color-mix(in srgb, ${c3} 10%, transparent) 0%, transparent 40%), var(--background)`,
        }}
      />

      {/* Grain texture overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 10,
          backgroundColor: colors.background
            ? `color-mix(in srgb, ${colors.background} 22%, transparent)`
            : 'transparent',
        }}
      >
        <div
          className="gradient-grain"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URI}")`,
            opacity: 0.14,
          }}
        />
      </div>
    </div>
  );
});
