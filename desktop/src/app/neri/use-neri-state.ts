import { useCallback, useSyncExternalStore } from "react";
import type { NeriWindowType, SearchResult } from "./neri-types";
import { getNeriStore } from "./neri-store";

/**
 * Thin React wrapper around the Neri singleton store.
 * Uses useSyncExternalStore so state persists across mount/unmount cycles.
 */
export function useNeriState() {
  const store = getNeriStore();

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const activeWorkspace = state.workspaces[state.activeWorkspaceIndex];

  const focusColumn = useCallback((index: number) => store.dispatch({ type: "focus-column", index }), [store]);
  const focusLeft = useCallback(() => store.dispatch({ type: "focus-left" }), [store]);
  const focusRight = useCallback(() => store.dispatch({ type: "focus-right" }), [store]);
  const openWindow = useCallback((windowType: NeriWindowType) => store.dispatch({ type: "open-window", windowType }), [store]);
  const closeWindow = useCallback((columnId: string, windowId: string) => store.dispatch({ type: "close-window", columnId, windowId }), [store]);
  const switchWorkspace = useCallback((index: number) => store.dispatch({ type: "switch-workspace", index }), [store]);
  const moveColumnLeft = useCallback(() => store.dispatch({ type: "move-column-left" }), [store]);
  const moveColumnRight = useCallback(() => store.dispatch({ type: "move-column-right" }), [store]);
  const moveToWorkspace = useCallback((columnId: string, workspaceIndex: number) => store.dispatch({ type: "move-to-workspace", columnId, workspaceIndex }), [store]);
  const openSearchWindow = useCallback((query: string, results: SearchResult[]) => store.dispatch({ type: "open-search-window", query, results }), [store]);
  const updateSearchResults = useCallback((results: SearchResult[]) => store.dispatch({ type: "update-search-results", results }), [store]);
  const openCanvasWindow = useCallback((title: string, html: string) => store.dispatch({ type: "open-canvas-window", title, html }), [store]);
  const closeWindowByType = useCallback((windowType: NeriWindowType) => store.dispatch({ type: "close-window-by-type", windowType }), [store]);

  return {
    state,
    activeWorkspace,
    focusColumn,
    focusLeft,
    focusRight,
    openWindow,
    closeWindow,
    switchWorkspace,
    moveColumnLeft,
    moveColumnRight,
    moveToWorkspace,
    openSearchWindow,
    updateSearchResults,
    openCanvasWindow,
    closeWindowByType,
  };
}
