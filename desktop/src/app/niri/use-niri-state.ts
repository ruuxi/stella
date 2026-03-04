import { useReducer, useCallback } from "react";
import type { NiriState, NiriWorkspace, NiriWindowType, NiriColumn, NiriWindow } from "./niri-types";
import { WINDOW_TEMPLATES } from "./niri-types";

let nextId = 1;
const uid = () => `niri-${nextId++}`;

function makeWindow(type: NiriWindowType): NiriWindow {
  const t = WINDOW_TEMPLATES[type];
  return { id: uid(), type, title: t.title, width: t.width, height: -1 };
}

function makeColumn(type: NiriWindowType): NiriColumn {
  return { id: uid(), windows: [makeWindow(type)] };
}

function emptyWorkspace(): NiriWorkspace {
  return { id: uid(), columns: [], focusedColumnIndex: -1, scrollX: 0 };
}

const INITIAL_TYPES: NiriWindowType[] = ["news-feed", "music-player", "ai-search", "calendar"];

function createInitialState(): NiriState {
  const ws: NiriWorkspace = {
    id: uid(),
    columns: INITIAL_TYPES.map(makeColumn),
    focusedColumnIndex: 0,
    scrollX: 0,
  };
  return {
    workspaces: [ws, emptyWorkspace()],
    activeWorkspaceIndex: 0,
  };
}

type NiriAction =
  | { type: "focus-column"; index: number }
  | { type: "focus-left" }
  | { type: "focus-right" }
  | { type: "open-window"; windowType: NiriWindowType }
  | { type: "close-window"; columnId: string; windowId: string }
  | { type: "switch-workspace"; index: number }
  | { type: "move-column-left" }
  | { type: "move-column-right" }
  | { type: "scroll"; x: number }
  | { type: "move-to-workspace"; columnId: string; workspaceIndex: number };

function ensureTrailingEmpty(workspaces: NiriWorkspace[]): NiriWorkspace[] {
  const last = workspaces[workspaces.length - 1];
  if (!last || last.columns.length > 0) {
    return [...workspaces, emptyWorkspace()];
  }
  // Also prune consecutive empty workspaces at the end (keep only one)
  let i = workspaces.length - 1;
  while (i > 0 && workspaces[i].columns.length === 0 && workspaces[i - 1].columns.length === 0) {
    i--;
  }
  return workspaces.slice(0, i + 1);
}

function niriReducer(state: NiriState, action: NiriAction): NiriState {
  const ws = state.workspaces[state.activeWorkspaceIndex];

  switch (action.type) {
    case "focus-column": {
      const newWs = { ...ws, focusedColumnIndex: action.index };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
    }

    case "focus-left": {
      if (ws.focusedColumnIndex <= 0) return state;
      const newWs = { ...ws, focusedColumnIndex: ws.focusedColumnIndex - 1 };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
    }

    case "focus-right": {
      if (ws.focusedColumnIndex >= ws.columns.length - 1) return state;
      const newWs = { ...ws, focusedColumnIndex: ws.focusedColumnIndex + 1 };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
    }

    case "open-window": {
      const col = makeColumn(action.windowType);
      const insertIdx = ws.focusedColumnIndex + 1;
      const newColumns = [...ws.columns];
      newColumns.splice(insertIdx, 0, col);
      const newWs = { ...ws, columns: newColumns, focusedColumnIndex: insertIdx };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces: ensureTrailingEmpty(workspaces) };
    }

    case "close-window": {
      const colIdx = ws.columns.findIndex((c) => c.id === action.columnId);
      if (colIdx === -1) return state;
      const col = ws.columns[colIdx];
      const remainingWindows = col.windows.filter((w) => w.id !== action.windowId);
      let newColumns: NiriColumn[];
      if (remainingWindows.length === 0) {
        newColumns = ws.columns.filter((_, i) => i !== colIdx);
      } else {
        newColumns = ws.columns.map((c, i) =>
          i === colIdx ? { ...c, windows: remainingWindows } : c,
        );
      }
      const newFocus = Math.min(ws.focusedColumnIndex, Math.max(0, newColumns.length - 1));
      const newWs = { ...ws, columns: newColumns, focusedColumnIndex: newFocus };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces: ensureTrailingEmpty(workspaces) };
    }

    case "switch-workspace": {
      if (action.index < 0 || action.index >= state.workspaces.length) return state;
      return { ...state, activeWorkspaceIndex: action.index };
    }

    case "move-column-left": {
      if (ws.focusedColumnIndex <= 0) return state;
      const newColumns = [...ws.columns];
      const i = ws.focusedColumnIndex;
      [newColumns[i - 1], newColumns[i]] = [newColumns[i], newColumns[i - 1]];
      const newWs = { ...ws, columns: newColumns, focusedColumnIndex: i - 1 };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
    }

    case "move-column-right": {
      if (ws.focusedColumnIndex >= ws.columns.length - 1) return state;
      const newColumns = [...ws.columns];
      const i = ws.focusedColumnIndex;
      [newColumns[i], newColumns[i + 1]] = [newColumns[i + 1], newColumns[i]];
      const newWs = { ...ws, columns: newColumns, focusedColumnIndex: i + 1 };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
    }

    case "scroll": {
      const newWs = { ...ws, scrollX: action.x };
      const workspaces = [...state.workspaces];
      workspaces[state.activeWorkspaceIndex] = newWs;
      return { ...state, workspaces };
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

    default:
      return state;
  }
}

export function useNiriState() {
  const [state, dispatch] = useReducer(niriReducer, null, createInitialState);

  const activeWorkspace = state.workspaces[state.activeWorkspaceIndex];

  const focusColumn = useCallback((index: number) => dispatch({ type: "focus-column", index }), []);
  const focusLeft = useCallback(() => dispatch({ type: "focus-left" }), []);
  const focusRight = useCallback(() => dispatch({ type: "focus-right" }), []);
  const openWindow = useCallback((windowType: NiriWindowType) => dispatch({ type: "open-window", windowType }), []);
  const closeWindow = useCallback((columnId: string, windowId: string) => dispatch({ type: "close-window", columnId, windowId }), []);
  const switchWorkspace = useCallback((index: number) => dispatch({ type: "switch-workspace", index }), []);
  const moveColumnLeft = useCallback(() => dispatch({ type: "move-column-left" }), []);
  const moveColumnRight = useCallback(() => dispatch({ type: "move-column-right" }), []);
  const scroll = useCallback((x: number) => dispatch({ type: "scroll", x }), []);
  const moveToWorkspace = useCallback((columnId: string, workspaceIndex: number) => dispatch({ type: "move-to-workspace", columnId, workspaceIndex }), []);

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
    scroll,
    moveToWorkspace,
  };
}
