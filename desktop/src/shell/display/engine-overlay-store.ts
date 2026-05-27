/**
 * Tiny singleton store for the inline Engine overlay that lives at the
 * bottom of the Chat home overview. Replaces the old dedicated Engine
 * display tab — the engine surface now opens in-place over the chat
 * home launcher instead of swapping the display panel's active tab.
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

let isOpen = false;
const listeners = new Set<Listener>();

const emit = (): void => {
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
