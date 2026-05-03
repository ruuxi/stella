import { EMOJI_SHEETS } from "@/app/chat/emoji-sprites/cells";

/**
 * Look up the literal emoji glyph stored at `(sheet, cell)` so the
 * `coverEmoji` field can be set without asking the user to type. Lives
 * outside `EmojiCellPreview.tsx` so HMR/fast-refresh keeps that file
 * pure-component.
 */
export const glyphForCell = (sheet: number, cell: number): string => {
  const list = EMOJI_SHEETS[sheet];
  if (!list) return "";
  return list[cell] ?? "";
};
