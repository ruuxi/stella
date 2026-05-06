import type { CSSProperties } from "react";
import { cn } from "@/shared/lib/utils";

type CellPreviewProps = {
  /** Direct URL to the sheet WebP — works for both R2-hosted packs and
   *  local object URLs from in-flight generation. */
  sheetUrl: string;
  /** Cell index inside the 6×6 sheet (row-major, 0–35). */
  cell: number;
  /** Render size in px. */
  size?: number;
  gridSize: number;
  className?: string;
};

/**
 * Render a single emoji cell from a sprite sheet via CSS background-position.
 * Identical math to `.markdown .ai-emoji` but works outside markdown
 * context so dialogs and grids can show pack artwork directly.
 */
export function EmojiCellPreview({
  sheetUrl,
  cell,
  size = 32,
  gridSize,
  className,
}: CellPreviewProps) {
  const row = Math.floor(cell / gridSize);
  const col = cell % gridSize;
  const last = Math.max(1, gridSize - 1);
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundImage: `url("${sheetUrl}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${gridSize * 100}% ${gridSize * 100}%`,
    backgroundPosition: `${(col / last) * 100}% ${(row / last) * 100}%`,
    backgroundColor: "transparent",
  };
  return <span className={cn("emoji-cell-preview", className)} style={style} />;
}
