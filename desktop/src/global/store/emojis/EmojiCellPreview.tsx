import type { CSSProperties } from "react";
import { cn } from "@/shared/lib/utils";
import { EMOJI_SHEET_GRID_SIZE } from "@/app/chat/emoji-sprites/cells";
import { cellToRowCol } from "@/app/chat/emoji-sprites/sprite-map";

type CellPreviewProps = {
  /** Direct URL to the sheet WebP — works for both R2-hosted packs and
   *  local object URLs from in-flight generation. */
  sheetUrl: string;
  /** Cell index inside the 8×8 sheet (row-major, 0–63). */
  cell: number;
  /** Render size in px. */
  size?: number;
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
  className,
}: CellPreviewProps) {
  const { row, col } = cellToRowCol(cell);
  const last = EMOJI_SHEET_GRID_SIZE - 1;
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundImage: `url("${sheetUrl}")`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${EMOJI_SHEET_GRID_SIZE * 100}% ${EMOJI_SHEET_GRID_SIZE * 100}%`,
    backgroundPosition: `${(col / last) * 100}% ${(row / last) * 100}%`,
    backgroundColor: "transparent",
  };
  return <span className={cn("emoji-cell-preview", className)} style={style} />;
}
