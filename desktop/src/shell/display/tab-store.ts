/**
 * Singleton store backing the Display sidebar's tab manager.
 *
 * Exposed as a small custom store rather than a React context because the
 * tab list is mutated from many non-React surfaces — the Convex media
 * materializer, the runtime `display:update` IPC, the chat surface's
 * resource-pill click handlers, the global keyboard shortcuts. Any caller
 * with `import { displayTabs } from ".../tab-store"` can register a tab
 * without first having to climb back up the component tree.
 *
 * Mirrors the shape of Codex's `$c({ panelId, panelOpen$, setPanelOpen })`
 * factory: opening any tab activates it AND sets `panelOpen=true`. There
 * is no separate "open the panel" verb — UI surfaces never need to think
 * about that invariant.
 */

import { useSyncExternalStore } from "react";
import type { DisplayTab, DisplayTabSpec, OpenTabOptions } from "./types";

type Listener = () => void;

type TabStoreSnapshot = {
  tabs: DisplayTab[];
  activeTabId: string | null;
  panelOpen: boolean;
};

const EMPTY_SNAPSHOT: TabStoreSnapshot = {
  tabs: [],
  activeTabId: null,
  panelOpen: false,
};

let state: TabStoreSnapshot = EMPTY_SNAPSHOT;
let nextOrd = 1;
const listeners = new Set<Listener>();

const emit = (next: TabStoreSnapshot) => {
  state = next;
  for (const listener of listeners) listener();
};

const findIndex = (snap: TabStoreSnapshot, tabId: string): number =>
  snap.tabs.findIndex((tab) => tab.id === tabId);

/**
 * Public store surface. Always read through `displayTabs.subscribe` /
 * `useDisplayTabs` so callers stay reactive; never reach into the captured
 * `state` directly.
 */
export const displayTabs = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): TabStoreSnapshot {
    return state;
  },
  /**
   * Register or refresh a tab. If a tab with this id already exists, its
   * spec is replaced in place (so calling `openTab` twice with the same id
   * but different `props.prompt` updates the rendered viewer without
   * stacking another tab).
   *
   * Default activates the new/refreshed tab and opens the panel. Pass
   * `{ activate: false }` to register passively.
   */
  openTab(spec: DisplayTabSpec, opts: OpenTabOptions = {}): void {
    const activate = opts.activate ?? true;
    const openPanel = opts.openPanel ?? (activate ? true : state.panelOpen);
    const existingIndex = findIndex(state, spec.id);
    let nextTabs: DisplayTab[];

    if (existingIndex === -1) {
      const tab: DisplayTab = { ...spec, ord: nextOrd++ };
      nextTabs = [...state.tabs, tab];
    } else {
      const previous = state.tabs[existingIndex]!;
      const refreshed: DisplayTab = { ...spec, ord: previous.ord };
      nextTabs = state.tabs.map((tab, idx) =>
        idx === existingIndex ? refreshed : tab,
      );
    }

    emit({
      tabs: nextTabs,
      activeTabId: activate ? spec.id : (state.activeTabId ?? spec.id),
      panelOpen: openPanel,
    });
  },
  /**
   * Activate an existing tab by id. No-op if the id is unknown. Always
   * opens the panel as a side effect (matches Codex's `activateTab`
   * behaviour where activating from a closed panel re-opens it).
   */
  activateTab(tabId: string): void {
    if (findIndex(state, tabId) === -1) return;
    if (state.activeTabId === tabId && state.panelOpen) return;
    emit({ ...state, activeTabId: tabId, panelOpen: true });
  },
  /**
   * Close a tab. If it was the active tab, activates the most-recent
   * neighbouring tab; if no tabs remain, closes the panel.
   */
  closeTab(tabId: string): void {
    const idx = findIndex(state, tabId);
    if (idx === -1) return;
    const remaining = state.tabs.filter((tab) => tab.id !== tabId);
    if (remaining.length === 0) {
      emit({ tabs: [], activeTabId: null, panelOpen: false });
      return;
    }
    let nextActive = state.activeTabId;
    if (state.activeTabId === tabId) {
      const fallback = remaining[idx - 1] ?? remaining[idx] ?? remaining[0];
      nextActive = fallback?.id ?? null;
    }
    emit({ tabs: remaining, activeTabId: nextActive, panelOpen: state.panelOpen });
  },
  closeActiveTab(): void {
    if (state.activeTabId == null) return;
    this.closeTab(state.activeTabId);
  },
  /**
   * Move a tab to a different ordinal position by swapping with the tab at
   * `targetIndex`. Used by the tab strip drag handle.
   */
  reorderTab(tabId: string, targetIndex: number): void {
    const idx = findIndex(state, tabId);
    if (idx === -1) return;
    const clamped = Math.max(0, Math.min(targetIndex, state.tabs.length - 1));
    if (clamped === idx) return;
    const next = [...state.tabs];
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(clamped, 0, moved);
    emit({ ...state, tabs: next });
  },
  /**
   * Open / close the panel without changing the active tab. Closing here
   * leaves tabs intact so re-opening restores the previous selection.
   */
  setPanelOpen(open: boolean): void {
    if (state.panelOpen === open) return;
    emit({ ...state, panelOpen: open });
  },
  /**
   * Drop everything. Currently only used by hard-reset / sign-out flows
   * (and tests).
   */
  reset(): void {
    nextOrd = 1;
    emit(EMPTY_SNAPSHOT);
  },
};

/**
 * React binding. Returns the current snapshot and re-renders on any change
 * to the store.
 */
export const useDisplayTabs = (): TabStoreSnapshot =>
  useSyncExternalStore(
    displayTabs.subscribe,
    displayTabs.getSnapshot,
    displayTabs.getSnapshot,
  );

export const useActiveDisplayTab = (): DisplayTab | null => {
  const { tabs, activeTabId } = useDisplayTabs();
  if (activeTabId == null) return null;
  return tabs.find((tab) => tab.id === activeTabId) ?? null;
};
