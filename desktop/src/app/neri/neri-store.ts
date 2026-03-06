/**
 * Module-level singleton store for Neri dashboard state.
 *
 * Persists state across mount/unmount cycles so the overlay can be
 * hidden and re-shown without losing window state.
 *
 * Pattern mirrors getVoiceRuntimeState() in realtime-voice.ts.
 */
import type { NeriState, NeriWindowType, SearchResult } from "./neri-types";
import { WINDOW_TEMPLATES } from "./neri-types";

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

let nextId = 1;
const uid = () => `neri-${nextId++}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWindow(type: NeriWindowType, overrides?: Partial<{ title: string; searchResults: SearchResult[]; canvasHtml: string }>) {
  const t = WINDOW_TEMPLATES[type];
  return {
    id: uid(),
    type,
    title: overrides?.title ?? t.title,
    width: t.width,
    ...(overrides?.searchResults ? { searchResults: overrides.searchResults } : {}),
    ...(overrides?.canvasHtml ? { canvasHtml: overrides.canvasHtml } : {}),
  };
}

function makeColumn(type: NeriWindowType, overrides?: Partial<{ title: string; searchResults: SearchResult[]; canvasHtml: string }>) {
  return { id: uid(), windows: [makeWindow(type, overrides)] };
}

function emptyWorkspace() {
  return { id: uid(), columns: [], focusedColumnIndex: -1 } as import("./neri-types").NeriWorkspace;
}

function ensureTrailingEmpty(workspaces: import("./neri-types").NeriWorkspace[]) {
  const last = workspaces[workspaces.length - 1];
  if (!last || last.columns.length > 0) {
    return [...workspaces, emptyWorkspace()];
  }
  let i = workspaces.length - 1;
  while (i > 0 && workspaces[i].columns.length === 0 && workspaces[i - 1].columns.length === 0) {
    i--;
  }
  return workspaces.slice(0, i + 1);
}

/** Replace the active workspace in state, optionally ensuring a trailing empty workspace. */
function updateActive(
  state: NeriState,
  newWs: import("./neri-types").NeriWorkspace,
  trailing = false,
): NeriState {
  const workspaces = [...state.workspaces];
  workspaces[state.activeWorkspaceIndex] = newWs;
  return { ...state, workspaces: trailing ? ensureTrailingEmpty(workspaces) : workspaces };
}

/** Insert a column after the focused index in the active workspace. */
function insertColumn(state: NeriState, ws: import("./neri-types").NeriWorkspace, col: import("./neri-types").NeriColumn): NeriState {
  const insertIdx = ws.focusedColumnIndex + 1;
  const newColumns = [...ws.columns];
  newColumns.splice(insertIdx, 0, col);
  return updateActive(state, { ...ws, columns: newColumns, focusedColumnIndex: insertIdx }, true);
}

/** Remove windows matching a predicate from the active workspace. */
function removeWindows(
  state: NeriState,
  ws: import("./neri-types").NeriWorkspace,
  findCol: (c: import("./neri-types").NeriColumn) => boolean,
  filterWin: (w: import("./neri-types").NeriWindow) => boolean,
): NeriState {
  const colIdx = ws.columns.findIndex(findCol);
  if (colIdx === -1) return state;
  const col = ws.columns[colIdx];
  const remaining = col.windows.filter(filterWin);
  const newColumns = remaining.length === 0
    ? ws.columns.filter((_, i) => i !== colIdx)
    : ws.columns.map((c, i) => i === colIdx ? { ...c, windows: remaining } : c);
  const newFocus = Math.min(ws.focusedColumnIndex, Math.max(0, newColumns.length - 1));
  return updateActive(state, { ...ws, columns: newColumns, focusedColumnIndex: newFocus }, true);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type NeriAction =
  | { type: "focus-column"; index: number }
  | { type: "focus-left" }
  | { type: "focus-right" }
  | { type: "focus-window-by-type"; windowType: NeriWindowType }
  | { type: "open-window"; windowType: NeriWindowType }
  | { type: "close-window"; columnId: string; windowId: string }
  | { type: "switch-workspace"; index: number }
  | { type: "move-column-left" }
  | { type: "move-column-right" }
  | { type: "move-to-workspace"; columnId: string; workspaceIndex: number }
  | { type: "open-search-window"; query: string; results: SearchResult[] }
  | { type: "update-search-results"; results: SearchResult[] }
  | { type: "open-canvas-window"; title: string; html: string }
  | { type: "close-window-by-type"; windowType: NeriWindowType };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function createInitialState(): NeriState {
  const ws = {
    id: uid(),
    columns: (["news-feed", "music-player", "ai-search", "calendar"] as NeriWindowType[]).map((t) => makeColumn(t)),
    focusedColumnIndex: 0,
  };
  return {
    workspaces: [ws, emptyWorkspace()],
    activeWorkspaceIndex: 0,
  };
}

export function neriReducer(state: NeriState, action: NeriAction): NeriState {
  const ws = state.workspaces[state.activeWorkspaceIndex];

  switch (action.type) {
    case "focus-column":
      return updateActive(state, { ...ws, focusedColumnIndex: action.index });

    case "focus-left": {
      if (ws.focusedColumnIndex <= 0) return state;
      return updateActive(state, { ...ws, focusedColumnIndex: ws.focusedColumnIndex - 1 });
    }

    case "focus-right": {
      if (ws.focusedColumnIndex >= ws.columns.length - 1) return state;
      return updateActive(state, { ...ws, focusedColumnIndex: ws.focusedColumnIndex + 1 });
    }

    case "focus-window-by-type": {
      const index = ws.columns.findIndex((column) =>
        column.windows.some((window) => window.type === action.windowType),
      );
      if (index === -1) return state;
      return updateActive(state, { ...ws, focusedColumnIndex: index });
    }

    case "open-window":
      return insertColumn(state, ws, makeColumn(action.windowType));

    case "close-window":
      return removeWindows(
        state, ws,
        (c) => c.id === action.columnId,
        (w) => w.id !== action.windowId,
      );

    case "switch-workspace": {
      if (action.index < 0 || action.index >= state.workspaces.length) return state;
      return { ...state, activeWorkspaceIndex: action.index };
    }

    case "move-column-left": {
      if (ws.focusedColumnIndex <= 0) return state;
      const newColumns = [...ws.columns];
      const i = ws.focusedColumnIndex;
      [newColumns[i - 1], newColumns[i]] = [newColumns[i], newColumns[i - 1]];
      return updateActive(state, { ...ws, columns: newColumns, focusedColumnIndex: i - 1 });
    }

    case "move-column-right": {
      if (ws.focusedColumnIndex >= ws.columns.length - 1) return state;
      const newColumns = [...ws.columns];
      const i = ws.focusedColumnIndex;
      [newColumns[i], newColumns[i + 1]] = [newColumns[i + 1], newColumns[i]];
      return updateActive(state, { ...ws, columns: newColumns, focusedColumnIndex: i + 1 });
    }

    case "move-to-workspace": {
      const colIdx = ws.columns.findIndex((c) => c.id === action.columnId);
      if (colIdx === -1) return state;
      const col = ws.columns[colIdx];
      const srcColumns = ws.columns.filter((_, i) => i !== colIdx);
      const srcFocus = Math.min(ws.focusedColumnIndex, Math.max(0, srcColumns.length - 1));

      const targetWs = state.workspaces[action.workspaceIndex];
      const targetColumns = [...targetWs.columns, col];
      const targetFocus = targetColumns.length - 1;

      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = { ...ws, columns: srcColumns, focusedColumnIndex: srcFocus };
      workspaces[action.workspaceIndex] = { ...targetWs, columns: targetColumns, focusedColumnIndex: targetFocus };
      return { ...state, workspaces: ensureTrailingEmpty(workspaces) };
    }

    // Voice action windows

    case "open-search-window":
      return insertColumn(state, ws, makeColumn("search", { title: `Search: ${action.query}`, searchResults: action.results }));

    case "update-search-results": {
      const searchColIdx = ws.columns.findIndex((c) => c.windows.some((w) => w.type === "search"));
      if (searchColIdx === -1) return state;
      const newColumns = ws.columns.map((c, i) => {
        if (i !== searchColIdx) return c;
        return {
          ...c,
          windows: c.windows.map((w) =>
            w.type === "search" ? { ...w, searchResults: action.results } : w,
          ),
        };
      });
      return updateActive(state, { ...ws, columns: newColumns });
    }

    case "open-canvas-window":
      return insertColumn(state, ws, makeColumn("canvas", { title: action.title, canvasHtml: action.html }));

    case "close-window-by-type":
      return removeWindows(
        state, ws,
        (c) => c.windows.some((w) => w.type === action.windowType),
        (w) => w.type !== action.windowType,
      );

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Singleton Store
// ---------------------------------------------------------------------------

type Listener = () => void;

interface NeriStore {
  getState: () => NeriState;
  dispatch: (action: NeriAction) => void;
  subscribe: (listener: Listener) => () => void;
}

let store: NeriStore | null = null;

export function getNeriStore(): NeriStore {
  if (store) return store;

  let state = createInitialState();
  const listeners = new Set<Listener>();

  store = {
    getState: () => state,
    dispatch: (action: NeriAction) => {
      const next = neriReducer(state, action);
      if (next !== state) {
        state = next;
        listeners.forEach((l) => l());
      }
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  return store;
}

/**
 * Returns a summary of current windows for local voice action routing.
 */
export function getNeriWindowSummary(): Array<{ type: string; title: string }> {
  const s = getNeriStore().getState();
  const ws = s.workspaces[s.activeWorkspaceIndex];
  return ws.columns.flatMap((col) =>
    col.windows.map((w) => ({ type: w.type, title: w.title })),
  );
}
