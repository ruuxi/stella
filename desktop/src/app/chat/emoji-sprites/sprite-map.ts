/**
 * Lookup table + matcher for the AI-generated emoji sprite sheets.
 *
 * Built from the cached backend emoji grid manifest: each emoji string is
 * mapped to the `(sheet, cell)` pair that locates it on disk, and a regex
 * is compiled that matches any supported emoji in a longest-first order.
 *
 * Both the remark plugin and the markdown image override consume this
 * module; nothing else should construct sprite URLs by hand.
 */

import {
  getEmojiGridManifest,
  getEmojiSheetGridSize,
  getEmojiSheets,
} from "./cells";

export type EmojiSpriteCell = {
  /** 0-based sheet index — matches the backend manifest order. */
  sheet: number;
  /** 0-based cell index inside its sheet, row-major. */
  cell: number;
};

type SpriteCache = {
  version: string;
  lookup: ReadonlyMap<string, EmojiSpriteCell>;
  regexSource: string;
};

let spriteCache: SpriteCache | null = null;

const buildLookup = (sheets: string[][]): ReadonlyMap<string, EmojiSpriteCell> => {
  const map = new Map<string, EmojiSpriteCell>();
  sheets.forEach((sheet, sheetIndex) => {
    sheet.forEach((emoji, cellIndex) => {
      if (!map.has(emoji)) {
        map.set(emoji, { sheet: sheetIndex, cell: cellIndex });
      }
    });
  });
  return map;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildEmojiRegexSource = (
  lookup: ReadonlyMap<string, EmojiSpriteCell>,
): string => {
  const sorted = [...lookup.keys()].sort(
    (a, b) => b.length - a.length,
  );
  if (sorted.length === 0) return "(?!)";
  const alternation = sorted.map(escapeRegex).join("|");
  return `(${alternation})`;
};

const getSpriteCache = (): SpriteCache => {
  const manifest = getEmojiGridManifest();
  if (!manifest) {
    return {
      version: "",
      lookup: new Map<string, EmojiSpriteCell>(),
      regexSource: "(?!)",
    };
  }
  if (spriteCache?.version === manifest.version) return spriteCache;
  const lookup = buildLookup(manifest.sheets);
  spriteCache = {
    version: manifest.version,
    lookup,
    regexSource: buildEmojiRegexSource(lookup),
  };
  return spriteCache;
};

/**
 * Callers that need to scan incrementally must instantiate their own copy
 * because RegExp objects with the `g` flag carry a `lastIndex` cursor.
 */
export const cloneEmojiRegex = (): RegExp =>
  new RegExp(getSpriteCache().regexSource, "gu");

export const getEmojiSpriteCell = (emoji: string): EmojiSpriteCell | null =>
  getSpriteCache().lookup.get(emoji) ?? null;

export const getEmojiSpriteGridSize = (): number =>
  Math.max(1, getEmojiSheetGridSize());

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
  const sheets = getEmojiSheets();
  const gridSize = getEmojiSheetGridSize();
  if (sheetOneBased < 1 || sheetOneBased > sheets.length) return null;
  if (cell < 0 || cell >= gridSize * gridSize) {
    return null;
  }
  return { sheet: sheetOneBased - 1, cell };
};

/**
 * Translate a cell index into its row/col coordinates inside the sheet.
 * Uses the grid size from the cached backend manifest.
 */
export const cellToRowCol = (
  cell: number,
): { row: number; col: number } => ({
  row: Math.floor(cell / getEmojiSpriteGridSize()),
  col: cell % getEmojiSpriteGridSize(),
});
