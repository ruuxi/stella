import { memo } from "react";

// ─────────────────────────────────────────────────────────────────────────
// The animated "shifting gradient" background was removed in the redesign.
// Stella now renders on a single flat, opaque surface (see `index.css` and the
// theme palettes) — the loud, continuously-animating canvas was the #1 reason
// the app read as a "tech-art demo" rather than a calm native tool.
//
// This file is kept as a no-op so the two historical mount points
// (`FullShell`, `mini-entry`) and their props continue to typecheck without
// touching call sites. It renders nothing; the surrounding shell paints the
// solid background.
// ─────────────────────────────────────────────────────────────────────────

type GradientMode = "soft" | "flat";
type GradientColor = "relative" | "strong";

interface ShiftingGradientProps {
  className?: string;
  mode?: GradientMode;
  colorMode?: GradientColor;
  blurMultiplier?: number;
  scale?: number;
  lightweight?: boolean;
  /** When true, fills the nearest positioned ancestor instead of the viewport. */
  contained?: boolean;
}

function ShiftingGradientImpl(_props: ShiftingGradientProps) {
  return null;
}

export const ShiftingGradient = memo(ShiftingGradientImpl);

export default ShiftingGradient;
