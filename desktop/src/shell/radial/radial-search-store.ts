import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const radialSearchStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getOpen(): boolean {
    return open;
  },
  open(): void {
    if (open) return;
    open = true;
    emit();
  },
  close(): void {
    if (!open) return;
    open = false;
    emit();
  },
};

export const useRadialSearchOpen = (): boolean =>
  useSyncExternalStore(
    radialSearchStore.subscribe,
    radialSearchStore.getOpen,
    radialSearchStore.getOpen,
  );
