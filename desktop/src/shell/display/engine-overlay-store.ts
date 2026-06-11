/**
 * Tiny singleton store for the inline Engine overlay that lives at the
 * bottom of the Chat home overview. Replaces the old dedicated Engine
 * display tab — the engine surface now opens in-place over the chat
 * home launcher instead of swapping the display panel's active tab.
 */
import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

type Listener = () => void;

const STORAGE_KEY = "stella.displayPanel.engineOverlayOpen";

const readPersistedOpen = (): boolean => {
  if (typeof window === "undefined") return false;
  return uiState.getItem(STORAGE_KEY) === "1";
};

const writePersistedOpen = (next: boolean): void => {
  if (typeof window === "undefined") return;
  if (next) uiState.setItem(STORAGE_KEY, "1");
  else uiState.removeItem(STORAGE_KEY);
};

// Restored from the shared UI state store so the Models / engine surface survives a
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
