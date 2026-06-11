/**
 * Shared UI state — the renderer's durable key/value state (formerly
 * per-origin `localStorage`), persisted to `~/.stella/ui-state.json` so every
 * host (the Electron app and the plain-browser Vite dev tab) reads and writes
 * the same state.
 *
 * Values follow localStorage semantics: keys and values are strings. A `null`
 * value in `UiStateChanges` means "remove the key".
 */

export const UI_STATE_FILE_NAME = "ui-state.json";

export type UiStateSnapshot = Record<string, string>;

export type UiStateChanges = Record<string, string | null>;

/** Vite dev-server WS custom event pushing changes to browser dev tabs. */
export const UI_STATE_DEV_EVENT = "stella:ui-state-changed";

/** Vite dev-server HTTP write endpoint for browser dev tabs. */
export const UI_STATE_DEV_ENDPOINT = "/__stella/ui-state";

export type UiStateDevWriteRequest = {
  /** Random per-tab id so a writer can ignore its own WS broadcast echo. */
  clientId?: string;
  changes?: UiStateChanges;
  clear?: boolean;
};

export type UiStateDevChangedEvent = {
  /** Originating dev-tab client id; null for external (file watcher) changes. */
  clientId: string | null;
  changes: UiStateChanges;
};

const MAX_KEY_LENGTH = 1024;

export const sanitizeUiStateChanges = (
  value: unknown,
): UiStateChanges | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const changes: UiStateChanges = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
    if (entry === null || typeof entry === "string") {
      changes[key] = entry;
    }
  }
  return changes;
};
