/**
 * Tiny singleton store for the sidebar Models popover. Callers like
 * `openEngineDisplayTab()` and `stella:open-model-picker` flip this on
 * so the footer Models button opens its popover programmatically.
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

// Restored from the shared UI state store so programmatic open requests
// and the user's last open/closed choice survive panel close + reopen.
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
