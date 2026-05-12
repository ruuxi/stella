/**
 * Renderer-side mirror of the `readAloudEnabled` preference.
 *
 * Backed by the main-process IPC handlers — we load once on first
 * subscribe, keep an in-memory cache so toggling re-renders both the
 * toggle UI and any active read-aloud subscribers in lock-step, and
 * write back through IPC.
 *
 * Exposed as a `useSyncExternalStore`-compatible store so multiple
 * components (toggle button in the suggestion row, the play hook in
 * the full chat AND the sidebar chat) observe the same value without
 * prop-drilling.
 */

type Listener = () => void;

let cachedValue = false;
let loaded = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<Listener>();

const emit = () => {
  for (const listener of listeners) listener();
};

const loadOnce = (): Promise<void> => {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const value = await window.electronAPI?.system?.getReadAloudEnabled?.();
      cachedValue = value === true;
    } catch {
      cachedValue = false;
    } finally {
      loaded = true;
      emit();
    }
  })();
  return loadPromise;
};

export const readAloudPrefStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    void loadOnce();
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): boolean {
    return cachedValue;
  },
  getServerSnapshot(): boolean {
    return false;
  },
};

export async function setReadAloudEnabled(enabled: boolean): Promise<void> {
  const next = enabled === true;
  if (loaded && cachedValue === next) return;
  cachedValue = next;
  loaded = true;
  emit();
  try {
    await window.electronAPI?.system?.setReadAloudEnabled?.(next);
  } catch (err) {
    console.warn("[read-aloud] failed to persist pref:", err);
  }
}
