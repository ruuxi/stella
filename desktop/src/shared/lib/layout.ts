/**
 * Shared layout constants for the renderer.
 * Main process mirror: electron/layout-constants.ts (must stay in sync).
 */
export const RADIAL_SIZE = 280
/** The in-app right-button dial is compact; the global chord dial stays full-size. */
export const SHELL_RADIAL_SCALE = 0.75
export const FULL_SHELL_MIN_SIZE = { width: 480, height: 600 } as const
export const MINI_SHELL_SIZE = { width: 480, height: 700 } as const
