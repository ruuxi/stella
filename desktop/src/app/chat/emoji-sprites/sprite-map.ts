/**
 * Lookup table + matcher for the AI-generated emoji sprite sheets.
 *
 * Built once at module load from `cells.ts`: each emoji string is mapped
 * to the `(sheet, cell)` pair that locates it on disk, and a regex is
 * compiled that matches any of the supported emojis in a longest-first
 * order so multi-codepoint sequences (e.g. ❤️ = U+2764 + U+FE0F) are
 * caught before their single-codepoint prefix.
 *
 * Both the remark plugin and the markdown image override consume this
 * module; nothing else should construct sprite URLs by hand.
 */

import { EMOJI_SHEETS, EMOJI_SHEET_GRID_SIZE } from "./cells";

export type EmojiSpriteCell = {
  /** 0-based sheet index — matches the order of `EMOJI_SHEETS`. */
  sheet: number;
  /** 0-based cell index inside its sheet, row-major. */
  cell: number;
};

const buildLookup = (): ReadonlyMap<string, EmojiSpriteCell> => {
  const map = new Map<string, EmojiSpriteCell>();
  EMOJI_SHEETS.forEach((sheet, sheetIndex) => {
    sheet.forEach((emoji, cellIndex) => {
      if (!map.has(emoji)) {
        map.set(emoji, { sheet: sheetIndex, cell: cellIndex });
      }
    });
  });
  return map;
};

export const EMOJI_SPRITE_LOOKUP: ReadonlyMap<string, EmojiSpriteCell> =
  buildLookup();

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildEmojiRegex = (): RegExp => {
  const sorted = [...EMOJI_SPRITE_LOOKUP.keys()].sort(
    (a, b) => b.length - a.length,
  );
  const alternation = sorted.map(escapeRegex).join("|");
  return new RegExp(`(${alternation})`, "gu");
};

/**
 * Stateless source pattern for the lookup. Callers that need to scan
 * incrementally must instantiate their own copy via `cloneEmojiRegex()`
 * because RegExp objects with the `g` flag carry a `lastIndex` cursor.
 */
export const EMOJI_SPRITE_REGEX_SOURCE = buildEmojiRegex().source;

export const cloneEmojiRegex = (): RegExp =>
  new RegExp(EMOJI_SPRITE_REGEX_SOURCE, "gu");

/**
 * Sentinel URL for an emoji sprite cell, encoded as a fragment on the
 * actual sprite asset path so the URL stays valid (and the asset
 * preloads) even if the markdown image override doesn't fire.
 *
 *   /emoji-sprites/sheet-1.webp#emoji-cell=0
 */
export const buildEmojiSpriteUrl = ({ sheet, cell }: EmojiSpriteCell): string =>
  `/emoji-sprites/sheet-${sheet + 1}.webp#emoji-cell=${cell}`;

const URL_PATTERN =
  /^\/emoji-sprites\/sheet-(\d+)\.webp#emoji-cell=(\d+)$/;

export const parseEmojiSpriteUrl = (url: string): EmojiSpriteCell | null => {
  const match = url.match(URL_PATTERN);
  if (!match) return null;
  const sheetOneBased = Number.parseInt(match[1]!, 10);
  const cell = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(sheetOneBased) || !Number.isFinite(cell)) return null;
  if (sheetOneBased < 1 || sheetOneBased > EMOJI_SHEETS.length) return null;
  if (cell < 0 || cell >= EMOJI_SHEET_GRID_SIZE * EMOJI_SHEET_GRID_SIZE) {
    return null;
  }
  return { sheet: sheetOneBased - 1, cell };
};

/**
 * Translate a cell index into its row/col coordinates inside the sheet.
 * Same `EMOJI_SHEET_GRID_SIZE` constant the build script uses.
 */
export const cellToRowCol = (
  cell: number,
): { row: number; col: number } => ({
  row: Math.floor(cell / EMOJI_SHEET_GRID_SIZE),
  col: cell % EMOJI_SHEET_GRID_SIZE,
});
