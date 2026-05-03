/**
 * Ordered emoji lists for the AI-generated emoji sprite sheets.
 *
 * Each sheet is an 8×8 grid (64 cells). The index of an emoji in its
 * sheet array maps to its cell position in row-major order: index 0 is
 * top-left, index 7 is top-right, index 8 is second-row first cell,
 * …, index 63 is bottom-right.
 *
 * These arrays are the single source of truth for both:
 *   1. The image-generation prompt that produces `sheet-1.webp` and
 *      `sheet-2.webp` under `desktop/public/emoji-sprites/`.
 *   2. The chat renderer's emoji → sprite-cell lookup.
 *
 * Reordering or replacing an emoji here requires regenerating the
 * corresponding sprite sheet.
 */

export const EMOJI_SHEET_1: readonly string[] = [
  // row 0 — positive faces
  "😀", "😃", "😄", "😁", "😆", "😊", "🙂", "😉",
  // row 1 — love / joy faces
  "😍", "🥰", "😘", "😎", "🤩", "🥳", "😋", "🤗",
  // row 2 — thinking / neutral faces
  "🤔", "😅", "🙄", "😐", "😑", "😶", "🫡", "🤨",
  // row 3 — laughing / sad / angry faces
  "😂", "🤣", "😭", "😢", "😡", "😠", "😱", "🥺",
  // row 4 — positive hand gestures
  "👍", "👌", "🙏", "👋", "🙌", "💪", "👏", "✌️",
  // row 5 — hand gestures & people
  "👎", "✋", "🤝", "🫶", "🤞", "☝️", "👀", "🧠",
  // row 6 — hearts & sparkle
  "❤️", "🧡", "💛", "💚", "💙", "💜", "✨", "💯",
  // row 7 — status / work icons
  "✅", "❌", "⚠️", "ℹ️", "🔥", "🚀", "💡", "🎯",
];

export const EMOJI_SHEET_2: readonly string[] = [
  // row 0 — quirky / cool faces
  "😇", "🤓", "😏", "😬", "🤐", "🤫", "🤥", "🤪",
  // row 1 — sad / worried faces
  "😔", "😕", "😣", "😤", "😥", "😨", "😰", "😪",
  // row 2 — sick / overwhelmed faces
  "🤧", "🤒", "🤕", "🥶", "🥵", "😵", "🤯", "🥱",
  // row 3 — finger / hand gestures
  "🤘", "🤙", "🫰", "🫵", "🖐️", "🤲", "🫳", "🫴",
  // row 4 — hearts variants & star
  "💔", "💖", "💕", "💞", "💗", "💝", "💘", "⭐",
  // row 5 — work / notification icons
  "📝", "🔧", "🛠️", "📌", "🔍", "⏰", "🔔", "📢",
  // row 6 — tech / objects
  "💻", "📱", "🎧", "📚", "📦", "🎁", "🔑", "🔒",
  // row 7 — celebration / nature / food
  "🎉", "🏆", "☕", "🍕", "🌞", "🌙", "🌈", "🍀",
];

export const EMOJI_SHEETS: readonly (readonly string[])[] = [
  EMOJI_SHEET_1,
  EMOJI_SHEET_2,
];

export const EMOJI_SHEET_GRID_SIZE = 8;
export const EMOJI_SHEET_CELL_COUNT =
  EMOJI_SHEET_GRID_SIZE * EMOJI_SHEET_GRID_SIZE;
