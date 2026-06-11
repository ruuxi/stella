/**
 * Shared UI state client — the renderer's durable key/value store, replacing
 * per-origin `localStorage` so the Electron app and plain-browser Vite dev
 * tabs (`bun run dev`) share one state file (`~/.stella/ui-state.json`).
 *
 * Semantics mirror localStorage:
 *   - Reads are synchronous from an in-memory map, seeded before any app code
 *     runs via `window.__stellaUiState` (Electron preload sendSync, or the
 *     dev server's injected inline snapshot).
 *   - Writes update the map synchronously and persist async through the host
 *     adapter (Electron IPC, or the dev server's HTTP endpoint).
 *   - Changes from other windows/hosts dispatch synthetic `storage` events on
 *     `window`, so existing cross-window listeners keep working. Local writes
 *     do NOT fire `storage` in the writing window (localStorage parity).
 */

import {
  UI_STATE_DEV_ENDPOINT,
  UI_STATE_DEV_EVENT,
  type UiStateChanges,
  type UiStateDevChangedEvent,
} from "../../../../runtime/contracts/ui-state.js";

const FLUSH_DELAY_MS = 10;

// Windowless environments (unit tests, SSR-ish tooling) get a plain
// in-memory map with no adapter — reads/writes work, nothing persists.
const hasWindow = typeof window !== "undefined";

const memory = new Map<string, string>(
  Object.entries((hasWindow ? window.__stellaUiState : undefined) ?? {}),
);

// ── Host write adapter ──────────────────────────────────────────────────────

type WriteAdapter = {
  flushChanges: (changes: UiStateChanges) => void;
  clear: () => void;
};

const getStorageArea = (): Storage | null => {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

const dispatchStorageEvent = (
  key: string,
  oldValue: string | null,
  newValue: string | null,
) => {
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue,
        newValue,
        url: window.location.href,
        // Some listeners filter on `event.storageArea === localStorage`.
        storageArea: getStorageArea(),
      }),
    );
  } catch {
    // StorageEvent construction is best-effort; listeners simply miss a sync.
  }
};

/** Applies changes from another window/host: update memory + notify. */
const applyRemoteChanges = (changes: UiStateChanges) => {
  for (const [key, value] of Object.entries(changes)) {
    const oldValue = memory.get(key) ?? null;
    if (value === null) {
      if (!memory.has(key)) continue;
      memory.delete(key);
    } else {
      if (oldValue === value) continue;
      memory.set(key, value);
    }
    dispatchStorageEvent(key, oldValue, value);
  }
};

const createElectronAdapter = (): WriteAdapter | null => {
  const api = window.electronAPI?.uiState;
  if (!api) return null;
  api.onChanged(applyRemoteChanges);
  return {
    flushChanges: (changes) => api.apply(changes),
    clear: () => api.clear(),
  };
};

const createDevServerAdapter = (): WriteAdapter | null => {
  const hot = import.meta.hot;
  if (!hot) return null;
  const clientId = Math.random().toString(36).slice(2);
  hot.on(UI_STATE_DEV_EVENT, (data: UiStateDevChangedEvent) => {
    if (data.clientId === clientId) return;
    applyRemoteChanges(data.changes);
  });
  const post = (body: Record<string, unknown>) => {
    void fetch(UI_STATE_DEV_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, ...body }),
      // Lets the final flush on pagehide survive tab close/navigation.
      keepalive: true,
    }).catch(() => {});
  };
  return {
    flushChanges: (changes) => post({ changes }),
    clear: () => post({ clear: true }),
  };
};

/** In-memory only — windowless tests, or a bundle opened outside Electron. */
const noopAdapter: WriteAdapter = {
  flushChanges: () => {},
  clear: () => {},
};

const adapter = hasWindow
  ? (createElectronAdapter() ?? createDevServerAdapter() ?? noopAdapter)
  : noopAdapter;

// ── Write batching ──────────────────────────────────────────────────────────

let pending: UiStateChanges = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const flushPending = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const changes = pending;
  pending = {};
  if (Object.keys(changes).length > 0) {
    adapter.flushChanges(changes);
  }
};

const queueChange = (key: string, value: string | null) => {
  pending[key] = value;
  if (flushTimer === null) {
    flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
  }
};

if (hasWindow) {
  window.addEventListener("pagehide", flushPending);
}

// ── One-time legacy migration ───────────────────────────────────────────────

// First boot after the localStorage → shared-store cut: the file is empty but
// this origin still holds the user's state. Import it once; the flush
// persists it to ~/.stella/ui-state.json for every host. Legacy Better Auth
// blobs stay out — session state belongs to the main process, never here.
if (hasWindow && memory.size === 0) {
  try {
    const legacy = window.localStorage;
    for (let i = 0; legacy && i < legacy.length; i++) {
      const key = legacy.key(i);
      if (key === null || key.startsWith("better-auth")) continue;
      const value = legacy.getItem(key);
      if (value === null) continue;
      memory.set(key, value);
      queueChange(key, value);
    }
  } catch {
    // localStorage can throw in restricted contexts; fresh state is fine.
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export const uiState = {
  getItem(key: string): string | null {
    return memory.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    const normalized = String(value);
    if (memory.get(key) === normalized) return;
    memory.set(key, normalized);
    queueChange(key, normalized);
  },

  removeItem(key: string): void {
    if (!memory.has(key)) return;
    memory.delete(key);
    queueChange(key, null);
  },

  /** Removes every key on every host (account/data reset flows). */
  clear(): void {
    memory.clear();
    pending = {};
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    adapter.clear();
  },

  keys(): string[] {
    return [...memory.keys()];
  },
};
