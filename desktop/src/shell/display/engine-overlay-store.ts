/**
 * Tiny singleton store for the inline Engine overlay that lives at the
 * bottom of the Chat home overview. Replaces the old dedicated Engine
 * display tab — the engine surface now opens in-place over the chat
 * home launcher instead of swapping the display panel's active tab.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

const STORAGE_KEY = "stella.displayPanel.engineOverlayOpen";

const safeStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readPersistedOpen = (): boolean => {
  const storage = safeStorage();
  return storage?.getItem(STORAGE_KEY) === "1";
};

const writePersistedOpen = (next: boolean): void => {
  const storage = safeStorage();
  if (!storage) return;
  if (next) storage.setItem(STORAGE_KEY, "1");
  else storage.removeItem(STORAGE_KEY);
};

// Restored from localStorage so the Models / engine surface survives a
// panel close + reopen — and the frequent self-mod HMR/full reloads — and
// comes back open right where the user left it.
let isOpen = readPersistedOpen();
const listeners = new Set<Listener>();

const emit = (): void => {
  writePersistedOpen(isOpen);
  for (const listener of listeners) listener();
};

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const engineOverlay = {
  isOpen: (): boolean => isOpen,
  setOpen(next: boolean): void {
    if (next === isOpen) return;
    isOpen = next;
    emit();
  },
  toggle(): void {
    isOpen = !isOpen;
    emit();
  },
};

export function useEngineOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => false,
  );
}
