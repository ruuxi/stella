/**
 * Renderer-side mirror of the `readAloudEnabled` preference.
 *
 * Backed by the main-process IPC handlers — we load once on first
 * subscribe, keep an in-memory cache so toggling re-renders both the
 * toggle UI and any active read-aloud subscribers in lock-step, and
 * write back through IPC. Main broadcasts changes to every renderer so
 * turning the setting off in one window immediately stops playback in
 * chat surfaces mounted in another window.
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
let remoteListenerInstalled = false;
let revision = 0;
const listeners = new Set<Listener>();

const emit = () => {
  for (const listener of listeners) listener();
};

const setCachedValue = (value: boolean) => {
  const changed = !loaded || cachedValue !== value;
  cachedValue = value;
  loaded = true;
  if (changed) emit();
};

const installRemoteListener = () => {
  if (remoteListenerInstalled) return;
  remoteListenerInstalled = true;
  window.electronAPI?.system?.onReadAloudEnabledChanged?.((enabled) => {
    revision += 1;
    setCachedValue(enabled === true);
  });
};

const loadOnce = (): Promise<void> => {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  const loadRevision = revision;
  loadPromise = (async () => {
    try {
      const value = await window.electronAPI?.system?.getReadAloudEnabled?.();
      if (revision === loadRevision) {
        setCachedValue(value === true);
      }
    } catch {
      if (revision === loadRevision) {
        setCachedValue(false);
      }
    } finally {
      if (!loaded) setCachedValue(false);
    }
  })();
  return loadPromise;
};

export const readAloudPrefStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    installRemoteListener();
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
  revision += 1;
  setCachedValue(next);
  try {
    await window.electronAPI?.system?.setReadAloudEnabled?.(next);
  } catch (err) {
    console.warn("[read-aloud] failed to persist pref:", err);
  }
}
