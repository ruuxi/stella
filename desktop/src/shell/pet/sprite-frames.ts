import type { PetAnimationState } from "@/shared/contracts/pet";

/**
 * Pet sprite-sheet geometry.
 *
 * Every spritesheet shipped via the Codex Pet Share format is a single
 * 1536×1872 image arranged as 8 columns × 9 rows of 192×208 frames. The
 * renderer (`PetSprite`) draws one frame at a time by setting
 * `background-image` once and updating `background-position` on every
 * tick — never scaling the image, never re-uploading textures.
 */
export const SPRITE_COLUMNS = 8;
export const SPRITE_ROWS = 9;
export const SPRITE_FRAME_WIDTH = 192;
export const SPRITE_FRAME_HEIGHT = 208;

export type SpriteFrame = {
  rowIndex: number;
  columnIndex: number;
  frameDurationMs: number;
};

export type SpriteAnimation = {
  /** Frames to play in order. */
  frames: SpriteFrame[];
  /** When set, looping resumes from this index after `frames` plays once. */
  loopStartIndex: number | null;
};

/**
 * The idle "breathing" loop. Mirrors the row-0 sequence used by every
 * Codex Pet Share sheet; each pet's pose is in the same slot. The first
 * and last frames hold longer to read as a soft sigh.
 */
const IDLE_BASE: SpriteFrame[] = [
  { rowIndex: 0, columnIndex: 0, frameDurationMs: 280 },
  { rowIndex: 0, columnIndex: 1, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 2, frameDurationMs: 110 },
  { rowIndex: 0, columnIndex: 3, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 4, frameDurationMs: 140 },
  { rowIndex: 0, columnIndex: 5, frameDurationMs: 320 },
];

const IDLE_REST_MULTIPLIER = 6;

/** Slow "resting" idle used when the pet has nothing to react to. */
const IDLE_REST: SpriteFrame[] = IDLE_BASE.map((frame) => ({
  ...frame,
  frameDurationMs: frame.frameDurationMs * IDLE_REST_MULTIPLIER,
}));

const buildRow = (
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
): SpriteFrame[] =>
  Array.from({ length: frameCount }, (_unused, columnIndex) => ({
    rowIndex,
    columnIndex,
    frameDurationMs:
      columnIndex === frameCount - 1 ? finalFrameDurationMs : frameDurationMs,
  }));

/**
 * Per-state animation tables.
 *
 * Frame counts and timings come from the published Codex Pet Share viewer
 * (`https://codex-pet-share.pages.dev/assets/index-*.js`) — the same
 * spec every uploaded pet sheet conforms to. Keep these in lockstep with
 * the public spec so third-party sheets render identically here.
 */
const ANIMATION_TABLE: Record<PetAnimationState, SpriteFrame[]> = {
  idle: IDLE_BASE,
  jumping: buildRow(4, 5, 140, 280),
  review: buildRow(8, 6, 150, 280),
  running: buildRow(7, 6, 120, 220),
  "running-left": buildRow(2, 8, 120, 220),
  "running-right": buildRow(1, 8, 120, 220),
  waving: buildRow(3, 4, 140, 280),
  waiting: buildRow(6, 6, 150, 260),
  failed: buildRow(5, 8, 140, 240),
};

/**
 * Resolve the actual frame schedule for an animation state.
 *
 * `idle` loops forever on its slow rest cadence. Every other state plays
 * its full row three times, then settles back into the idle rest loop —
 * matching how Codex's pet runs a cheer/wave/run for a few cycles before
 * returning to ambient breathing without waiting for an external trigger.
 *
 * Honors `prefers-reduced-motion` by collapsing to a single static frame.
 */
export const resolveAnimation = (
  state: PetAnimationState,
  prefersReducedMotion: boolean,
  continuous = false,
): SpriteAnimation => {
  const baseFrames = ANIMATION_TABLE[state];
  if (prefersReducedMotion) {
    return { frames: [baseFrames[0]], loopStartIndex: null };
  }
  if (state === "idle") {
    return { frames: IDLE_REST, loopStartIndex: 0 };
  }
  if (continuous) {
    return { frames: baseFrames, loopStartIndex: 0 };
  }
  const reactive = [...baseFrames, ...baseFrames, ...baseFrames];
  return {
    frames: [...reactive, ...IDLE_REST],
    loopStartIndex: reactive.length,
  };
};

/**
 * CSS `background-position` for a single frame, expressed as percentages
 * so the sprite stays correctly placed regardless of the rendered size.
 *
 * The sheet is 800% × 900% of the rendered frame (8 cols × 9 rows), so
 * each step along an axis is `1 / (n - 1) * 100%`.
 */
export const formatFramePosition = (frame: SpriteFrame): string => {
  const x = (frame.columnIndex / (SPRITE_COLUMNS - 1)) * 100;
  const y = (frame.rowIndex / (SPRITE_ROWS - 1)) * 100;
  return `${x}% ${y}%`;
};
