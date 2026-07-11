/**
 * Effective on-screen state of the docked left sidebar (visible AND not
 * force-hidden by breakpoints / window type). Written by the root chrome —
 * the single owner of `leftSidebarVisible` + shell breakpoints — and read by
 * the composer activity pill, which suppresses its running state while the
 * sidebar's Activity section is visible.
 *
 * A tiny module store (not React state) because the root chrome and the
 * composer live in separate parts of the tree and threading a prop through
 * the router would touch every intermediate surface. Plain module store +
 * `useSyncExternalStore` mirrors the other shell singletons
 * (`display-search-store`, etc.).
 */
import { useSyncExternalStore } from "react";

let docked = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const leftSidebarVisibilityStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isDocked(): boolean {
    return docked;
  },
  setDocked(next: boolean): void {
    if (next === docked) return;
    docked = next;
    emit();
  },
};

/** True while the docked left sidebar is actually rendered on screen. */
export const useLeftSidebarDocked = (): boolean =>
  useSyncExternalStore(
    leftSidebarVisibilityStore.subscribe,
    leftSidebarVisibilityStore.isDocked,
    leftSidebarVisibilityStore.isDocked,
  );
