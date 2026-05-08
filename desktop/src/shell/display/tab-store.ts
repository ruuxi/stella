/**
 * Singleton store backing the workspace panel's tab manager.
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

/**
 * Slice surfaced to consumers that only care about the tab list itself
 * (the tab strip, the +-menu, the active tab body). Layout state
 * (panelOpen / panelExpanded / panelWidth) is intentionally absent so
 * pointer-driven resize doesn't re-render every tab consumer at 60–120 Hz.
 */
export type DisplayTabListSnapshot = {
  tabs: ReadonlyArray<DisplayTab>;
  activeTabId: string | null;
};

/**
 * Slice surfaced to consumers that only need panel layout state
 * (display sidebar, shell topbar, store route, etc.). Splitting this
 * away from the tab list lets resize/animation updates propagate
 * without triggering re-renders of the tab strip.
 */
export type DisplayPanelLayoutSnapshot = {
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
 * Combined snapshot kept around for the legacy `useDisplayTabs()` hook
 * (which fires on any change). Prefer `useDisplayTabList()` /
 * `useDisplayPanelLayout()` for new consumers.
 */
type TabStoreSnapshot = DisplayTabListSnapshot & DisplayPanelLayoutSnapshot;

/**
 * Width clamp applied to the user's resize gesture.
 *
 * The panel itself has only a minimum useful width. Its maximum is derived
 * at drag time from the available shell width after reserving the left
 * sidebar/rail and `DISPLAY_MAIN_CONTENT_MIN_WIDTH` for the main outlet.
 * Use the expand toggle for the "fully take over" case.
 */
export const DISPLAY_PANEL_MIN_WIDTH = 320;
export const DISPLAY_MAIN_CONTENT_MIN_WIDTH = 400;

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

const writePersistedWidthNow = (width: number | null): void => {
  const storage = safeStorage();
  if (!storage) return;
  if (width == null) storage.removeItem(STORAGE_KEY_WIDTH);
  else storage.setItem(STORAGE_KEY_WIDTH, String(Math.round(width)));
};

// Coalesce width writes during a drag — `setPanelWidth` fires per
// pointermove (60–120 Hz) and the synchronous `localStorage.setItem`
// adds up. We keep the latest value and flush it on a short timer plus
// on `pagehide` so the user's last position survives a reload.
let pendingPersistedWidth: { value: number | null } | null = null;
let persistedWidthTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_WIDTH_DEBOUNCE_MS = 150;

const flushPersistedWidth = () => {
  if (persistedWidthTimer) {
    clearTimeout(persistedWidthTimer);
    persistedWidthTimer = null;
  }
  if (!pendingPersistedWidth) return;
  writePersistedWidthNow(pendingPersistedWidth.value);
  pendingPersistedWidth = null;
};

const schedulePersistedWidth = (width: number | null): void => {
  pendingPersistedWidth = { value: width };
  if (persistedWidthTimer) return;
  persistedWidthTimer = setTimeout(() => {
    persistedWidthTimer = null;
    flushPersistedWidth();
  }, PERSIST_WIDTH_DEBOUNCE_MS);
};

if (typeof window !== "undefined") {
  // Last-chance flush on tab close / app quit so the user's most
  // recent panel width isn't dropped because the debounce was still
  // pending.
  window.addEventListener("pagehide", flushPersistedWidth);
  window.addEventListener("beforeunload", flushPersistedWidth);
}

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
let tabListSnapshot: DisplayTabListSnapshot = {
  tabs: state.tabs,
  activeTabId: state.activeTabId,
};
let layoutSnapshot: DisplayPanelLayoutSnapshot = {
  panelOpen: state.panelOpen,
  panelExpanded: state.panelExpanded,
  panelWidth: state.panelWidth,
};
let nextOrd = 1;
const listeners = new Set<Listener>();
const tabListListeners = new Set<Listener>();
const layoutListeners = new Set<Listener>();

type EmitOptions = {
  /** Did the tab list / active tab change? */
  tabsChanged?: boolean;
  /** Did panelOpen / panelExpanded / panelWidth change? */
  layoutChanged?: boolean;
};

const emit = (next: TabStoreSnapshot, options: EmitOptions = {}) => {
  state = next;
  if (options.tabsChanged) {
    tabListSnapshot = { tabs: next.tabs, activeTabId: next.activeTabId };
    for (const listener of tabListListeners) listener();
  }
  if (options.layoutChanged) {
    layoutSnapshot = {
      panelOpen: next.panelOpen,
      panelExpanded: next.panelExpanded,
      panelWidth: next.panelWidth,
    };
    for (const listener of layoutListeners) listener();
  }
  // Legacy `useDisplayTabs()` consumers fire on any change so we don't
  // silently break callers that still want the union snapshot.
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
  /**
   * Tab-list–only subscription. Fires when the tab list or active tab
   * changes; ignores panel layout updates (open/expanded/width).
   */
  subscribeTabList(listener: Listener): () => void {
    tabListListeners.add(listener);
    return () => tabListListeners.delete(listener);
  },
  /**
   * Layout-only subscription. Fires for panel open/expanded/width
   * changes; ignores tab-list mutations.
   */
  subscribeLayout(listener: Listener): () => void {
    layoutListeners.add(listener);
    return () => layoutListeners.delete(listener);
  },
  getSnapshot(): TabStoreSnapshot {
    return state;
  },
  getTabListSnapshot(): DisplayTabListSnapshot {
    return tabListSnapshot;
  },
  getLayoutSnapshot(): DisplayPanelLayoutSnapshot {
    return layoutSnapshot;
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

    const nextActiveTabId = activate
      ? spec.id
      : (state.activeTabId ?? spec.id);
    emit(
      {
        ...state,
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        panelOpen: openPanel,
      },
      {
        tabsChanged: true,
        layoutChanged: openPanel !== state.panelOpen,
      },
    );
  },
  /**
   * Activate an existing tab by id. No-op if the id is unknown. Always
   * opens the panel as a side effect (matches Codex's `activateTab`
   * behaviour where activating from a closed panel re-opens it).
   */
  activateTab(tabId: string): void {
    if (findIndex(state, tabId) === -1) return;
    if (state.activeTabId === tabId && state.panelOpen) return;
    const tabsChanged = state.activeTabId !== tabId;
    const layoutChanged = !state.panelOpen;
    emit(
      { ...state, activeTabId: tabId, panelOpen: true },
      { tabsChanged, layoutChanged },
    );
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
      emit(
        { ...state, tabs: [], activeTabId: null, panelOpen: false },
        { tabsChanged: true, layoutChanged: state.panelOpen },
      );
      return;
    }
    let nextActive = state.activeTabId;
    if (state.activeTabId === tabId) {
      const fallback = remaining[idx - 1] ?? remaining[idx] ?? remaining[0];
      nextActive = fallback?.id ?? null;
    }
    emit(
      { ...state, tabs: remaining, activeTabId: nextActive },
      { tabsChanged: true },
    );
  },
  /**
   * Open / close the panel without changing the active tab. Closing here
   * leaves tabs intact so re-opening restores the previous selection.
   */
  setPanelOpen(open: boolean): void {
    if (state.panelOpen === open) return;
    emit({ ...state, panelOpen: open }, { layoutChanged: true });
  },
  reorderTab(tabId: string, targetIndex: number): void {
    const idx = findIndex(state, tabId);
    if (idx === -1) return;
    const boundedTarget = Math.max(
      0,
      Math.min(targetIndex, state.tabs.length - 1),
    );
    if (idx === boundedTarget) return;

    const nextTabs = [...state.tabs];
    const [tab] = nextTabs.splice(idx, 1);
    if (!tab) return;
    nextTabs.splice(boundedTarget, 0, tab);
    emit({ ...state, tabs: nextTabs }, { tabsChanged: true });
  },
  /**
   * Toggle / set the "expand to fill" mode. While expanded, the panel
   * occupies the entire content area to the right of the rail; the chat
   * outlet is hidden via `:has(.display-sidebar--expanded)` in CSS.
   */
  setPanelExpanded(expanded: boolean): void {
    if (state.panelExpanded === expanded) return;
    writePersistedExpanded(expanded);
    emit({ ...state, panelExpanded: expanded }, { layoutChanged: true });
  },
  togglePanelExpanded(): void {
    this.setPanelExpanded(!state.panelExpanded);
  },
  /**
   * Persist the user-chosen width (in CSS pixels). `null` reverts to the
   * stylesheet default. Callers are responsible for clamping to the
   * panel minimum and main-content-derived maximum before invoking this.
   *
   * `localStorage` writes are coalesced so a pointer-driven drag at
   * 60–120 Hz doesn't synchronously hit storage on every move.
   */
  setPanelWidth(width: number | null): void {
    if (state.panelWidth === width) return;
    schedulePersistedWidth(width);
    emit({ ...state, panelWidth: width }, { layoutChanged: true });
  },
  /**
   * Force the pending panel-width to disk now. Call this on
   * pointer-up to make sure the latest drag value is persisted even if
   * the user reloads before the debounce window elapses.
   */
  flushPersistedWidth,
  reset(): void {
    nextOrd = 1;
    writePersistedExpanded(false);
    writePersistedWidthNow(null);
    pendingPersistedWidth = null;
    if (persistedWidthTimer) {
      clearTimeout(persistedWidthTimer);
      persistedWidthTimer = null;
    }
    emit(
      {
        tabs: [],
        activeTabId: null,
        panelOpen: false,
        panelExpanded: false,
        panelWidth: null,
      },
      { tabsChanged: true, layoutChanged: true },
    );
  },
};

/**
 * React binding. Returns the current snapshot and re-renders on any change
 * to the store. Prefer `useDisplayTabList` or `useDisplayPanelLayout` —
 * this fires for both kinds of change and re-renders unnecessarily during
 * pointer-driven resize.
 */
export const useDisplayTabs = (): TabStoreSnapshot =>
  useSyncExternalStore(
    displayTabs.subscribe,
    displayTabs.getSnapshot,
    displayTabs.getSnapshot,
  );

/**
 * Subscribe to just the tab list slice (tabs + activeTabId). Use this
 * for the tab strip, the +-menu, and active-tab consumers so panel
 * resize/animation updates don't trigger their re-renders.
 */
export const useDisplayTabList = (): DisplayTabListSnapshot =>
  useSyncExternalStore(
    displayTabs.subscribeTabList,
    displayTabs.getTabListSnapshot,
    displayTabs.getTabListSnapshot,
  );

/**
 * Subscribe to just the panel-layout slice (panelOpen, panelExpanded,
 * panelWidth). Used by the sidebar shell, top bar, and store layout —
 * tab strip consumers should use `useDisplayTabList` instead.
 */
export const useDisplayPanelLayout = (): DisplayPanelLayoutSnapshot =>
  useSyncExternalStore(
    displayTabs.subscribeLayout,
    displayTabs.getLayoutSnapshot,
    displayTabs.getLayoutSnapshot,
  );

export const useActiveDisplayTab = (): DisplayTab | null => {
  const { tabs, activeTabId } = useDisplayTabList();
  if (activeTabId == null) return null;
  return tabs.find((tab) => tab.id === activeTabId) ?? null;
};
