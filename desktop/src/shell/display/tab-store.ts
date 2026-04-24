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
  /**
   * When true, the panel takes over the entire content area beside the
   * left rail. Persists across reloads.
   */
  panelExpanded: boolean;
  /**
   * User-resized width in CSS pixels. `null` means "use the default
   * `clamp()` width baked into the stylesheet". Persisted to localStorage
   * so the choice survives reloads.
   */
  panelWidth: number | null;
};

/**
 * Width clamp applied to the user's resize gesture.
 *
 * `DISPLAY_PANEL_MAX_RATIO` is the soft cap on wide windows — the panel
 * can never grow past 60% of the viewport, so dragging always leaves a
 * usable chat column. `DISPLAY_PANEL_MAX_RESERVED_PX` is the absolute
 * floor: on narrow windows where 70% would still feel too wide, we make
 * sure at least this many pixels remain for the rail + chat. The
 * effective max is `min(width * ratio, width - reserved)`. Use the
 * expand toggle for the "fully take over" case.
 */
export const DISPLAY_PANEL_MIN_WIDTH = 320;
export const DISPLAY_PANEL_MAX_RATIO = 0.6;
export const DISPLAY_PANEL_MAX_RESERVED_PX = 240;

const STORAGE_KEY_WIDTH = "stella.displayPanel.width";
const STORAGE_KEY_EXPANDED = "stella.displayPanel.expanded";

const safeStorage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const readPersistedWidth = (): number | null => {
  const storage = safeStorage();
  if (!storage) return null;
  const raw = storage.getItem(STORAGE_KEY_WIDTH);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const readPersistedExpanded = (): boolean => {
  const storage = safeStorage();
  if (!storage) return false;
  return storage.getItem(STORAGE_KEY_EXPANDED) === "1";
};

const writePersistedWidth = (width: number | null): void => {
  const storage = safeStorage();
  if (!storage) return;
  if (width == null) storage.removeItem(STORAGE_KEY_WIDTH);
  else storage.setItem(STORAGE_KEY_WIDTH, String(Math.round(width)));
};

const writePersistedExpanded = (expanded: boolean): void => {
  const storage = safeStorage();
  if (!storage) return;
  if (expanded) storage.setItem(STORAGE_KEY_EXPANDED, "1");
  else storage.removeItem(STORAGE_KEY_EXPANDED);
};

const EMPTY_SNAPSHOT: TabStoreSnapshot = {
  tabs: [],
  activeTabId: null,
  panelOpen: false,
  panelExpanded: readPersistedExpanded(),
  panelWidth: readPersistedWidth(),
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
      ...state,
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
      emit({ ...state, tabs: [], activeTabId: null, panelOpen: false });
      return;
    }
    let nextActive = state.activeTabId;
    if (state.activeTabId === tabId) {
      const fallback = remaining[idx - 1] ?? remaining[idx] ?? remaining[0];
      nextActive = fallback?.id ?? null;
    }
    emit({ ...state, tabs: remaining, activeTabId: nextActive });
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
   * Toggle / set the "expand to fill" mode. While expanded, the panel
   * occupies the entire content area to the right of the rail; the chat
   * outlet is hidden via `:has(.display-sidebar--expanded)` in CSS.
   */
  setPanelExpanded(expanded: boolean): void {
    if (state.panelExpanded === expanded) return;
    writePersistedExpanded(expanded);
    emit({ ...state, panelExpanded: expanded });
  },
  togglePanelExpanded(): void {
    this.setPanelExpanded(!state.panelExpanded);
  },
  /**
   * Persist the user-chosen width (in CSS pixels). `null` reverts to the
   * stylesheet default. Callers are responsible for clamping to the
   * `DISPLAY_PANEL_MIN_WIDTH` / window-derived max before invoking this.
   */
  setPanelWidth(width: number | null): void {
    if (state.panelWidth === width) return;
    writePersistedWidth(width);
    emit({ ...state, panelWidth: width });
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
