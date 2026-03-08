import { useMemo } from "react";
import { useTheme } from "@/context/theme-context";
import { cssToRgb } from "@/shared/lib/color";

type RGB = [number, number, number];

/** Returns the 4 spinner theme colors as parsed [r,g,b] tuples (0–255). */
export function useSpinnerColors(): RGB[] {
  const { colors } = useTheme();
  return useMemo(
    () => [
      cssToRgb(colors.interactive),
      cssToRgb(colors.success),
      cssToRgb(colors.warning),
      cssToRgb(colors.info),
    ],
    [colors.interactive, colors.success, colors.warning, colors.info],
  );
}
