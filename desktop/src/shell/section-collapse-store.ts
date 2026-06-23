/**
 * Per-section collapse state for the consolidated left sidebar (Apps,
 * Activity, Files, Schedule, Store). Persisted so a user's collapsed
 * sections survive reloads. Keyed by a stable section id string.
 */

import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella.sidebar.collapsedSections";

const readPersisted = (): Set<string> => {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
};

let collapsed = readPersisted();
const listeners = new Set<() => void>();

const persist = (): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
};

const emit = (): void => {
  // New Set reference so `useSyncExternalStore` consumers re-render.
  collapsed = new Set(collapsed);
  persist();
  for (const listener of listeners) listener();
};

export const sectionCollapseStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ReadonlySet<string> {
    return collapsed;
  },
  isCollapsed(id: string): boolean {
    return collapsed.has(id);
  },
  toggle(id: string): void {
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    emit();
  },
};

export const useSectionCollapsed = (id: string): boolean =>
  useSyncExternalStore(
    sectionCollapseStore.subscribe,
    () => sectionCollapseStore.getSnapshot().has(id),
    () => false,
  );
