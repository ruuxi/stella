/**
 * Shared search-query state for the unified display library overview.
 *
 * The top-bar search input writes here and the overview reads here, so the
 * two surfaces (which live in separate React trees) stay in sync without
 * prop-drilling through the shell. Plain module store + `useSyncExternalStore`
 * mirrors the other workspace-display singletons.
 */

import { useSyncExternalStore } from "react";

let query = "";
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const displaySearchStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getQuery(): string {
    return query;
  },
  setQuery(next: string): void {
    if (query === next) return;
    query = next;
    emit();
  },
  clear(): void {
    if (query === "") return;
    query = "";
    emit();
  },
};

export const useDisplaySearchQuery = (): string =>
  useSyncExternalStore(
    displaySearchStore.subscribe,
    displaySearchStore.getQuery,
    displaySearchStore.getQuery,
  );

/** Case-insensitive substring match helper shared by overview sections. */
export const matchesQuery = (haystack: string, q: string): boolean => {
  if (!q) return true;
  return haystack.toLowerCase().includes(q.toLowerCase());
};
