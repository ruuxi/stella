/**
 * Floating pet companion contract.
 *
 * The pet renders inside a dedicated transparent BrowserWindow. State flows
 * over IPC channels declared in
 * `@/shared/contracts/ipc-channels` (`IPC_PET_*`):
 *
 *   - `pet:status`        renderer → main → all renderers (mascot mood)
 *   - `pet:setOpen`       any window → main → all renderers (toggle)
 *   - `pet:openChat`      pet → main (focus full app, sidebar chat)
 *   - `pet:sendMessage`   pet composer → main → full shell chat
 *
 * Animation rows mirror the eight-by-nine sprite-sheet layout shared by
 * every pet on https://codex-pet-share.pages.dev — each pet is a
 * 1536×1872 webp arranged as 8 columns × 9 rows of 192×208 frames.
 * Custom pet packs only need to obey that grid.
 */

/** All animation rows exposed by a pet sprite sheet. */
export type PetAnimationState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

/** Mood the floating pet should display alongside its bubble copy. */
export type PetOverlayState =
  | "idle"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "waving";

/**
 * What the floating mascot should currently express.
 *
 * Produced by `useFullShellChat` from agent stream events and broadcast to
 * every window so the overlay (a separate React tree) can mirror it.
 */
export type PetOverlayStatus = {
  /** High-level mood; mapped to a sprite animation row by the overlay. */
  state: PetOverlayState;
  /** Short title rendered above the bubble (e.g. agent task name). */
  title: string;
  /** One-line latest status / assistant text shown in the bubble. */
  message: string;
  /** True while a turn is streaming — drives the spinner dot. */
  isLoading: boolean;
};
