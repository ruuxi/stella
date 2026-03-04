# Niri Window Manager Demo — Implementation Plan

## Overview
A fully interactive niri-clone UI that appears as a fullscreen overlay when clicking the "Niri" dev button. It's rendered inside the main renderer (not the Electron overlay window) as a fixed fullscreen portal, similar to the test dialog but covering the entire screen.

## Architecture

### Trigger
- Add `"niri"` to `DialogType` in `hooks.ts`
- Add a "Niri" button in `FullShell.tsx` dev-controls next to "Test UI"
- When `activeDialog === "niri"`, render `<NiriDemo>` fullscreen

### Component Structure
```
src/app/niri/
  NiriDemo.tsx          — Main fullscreen overlay component
  niri.css              — All styles
  niri-types.ts         — Types for windows, workspaces, columns
  use-niri-state.ts     — State management (useReducer) for windows/workspaces
  NiriWindow.tsx        — Individual window component (draggable column)
  NiriWorkspaceStrip.tsx — Horizontal scrollable strip of columns
  NiriStatusBar.tsx     — Top bar (workspace indicators, clock, etc.)
  NiriWorkspaceSwitcher.tsx — Vertical workspace overview
```

### Core Niri Mechanics
1. **Infinite horizontal strip**: Windows arranged as columns, horizontal scroll
2. **Columns**: Each window is a column. Can stack multiple windows vertically in one column.
3. **Dynamic workspaces**: Vertical stack, always one empty at bottom
4. **No resize on new window**: Opening a window appends to the right
5. **Smooth scrolling**: Animate scroll to focus on active window

### Placeholder Windows (Generative UI Mockups)
- News Feed — scrollable headlines with thumbnails
- Music Player — album art, progress bar, controls
- AI Web Search — search bar with results
- Calendar — month view with events
- Game — simple interactive canvas (e.g., bouncing ball / snake)
- System Monitor — CPU/RAM bars
- Weather — current conditions + forecast
- Notes — editable text area
- File Browser — tree view with folders/files

### Interactions
- Click window to focus (smooth scroll to center it)
- Drag window titlebar to reorder columns
- Close button on each window
- Keyboard: Arrow Left/Right to switch focus, Super+Enter to "open new window"
- Workspace dots on left side — click to switch workspace
- Mouse wheel on strip for horizontal scroll
- Escape to close the niri demo

### Visual Design
- Dark theme matching niri's default look (dark gray bg, subtle borders)
- Window borders with focus indicator (accent color)
- Smooth CSS transitions for all movements
- Workspace indicator on left edge
- Status bar at top with workspace dots + clock
