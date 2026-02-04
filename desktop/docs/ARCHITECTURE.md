# Stella Architecture

## Overview
Stella is an Electron desktop app with a React/Vite renderer and a Convex-backed service layer. The main process is the "Local Host" boundary for OS-level capabilities. The renderer is UI-only and communicates through IPC + network calls.

## Boundary: Main vs Renderer

### Main Process (Local Host)
- Owns all native windows (Full + Mini).
- Hosts OS integrations (global hooks, screenshots, system permissions).
- Executes local tools and filesystem/OS actions.
- Exposes a narrow IPC surface for UI state and window control.
- Never runs Convex, Model Gateway, or AI prompt logic directly.

### Renderer (UI Only)
- Renders the UI shells and interaction flow.
- Sends IPC messages for window switching and Local Host actions.
- Calls Convex over the network for state and realtime.
- Calls the Model Gateway (Vercel AI SDK) for all AI requests.
- Does not access OS APIs directly (no Node integration).

## Two-Window Model

### Full Window
- Primary workspace layout with chat on the left and a right-side context panel.
- Standard window sizing and resizable.

### Mini Window
- Spotlight-like compact prompt with a small thread preview.
- Always-on-top, fixed size.

Switching windows is handled by the main process. The renderer requests the window change over IPC. The main process hides one window and shows the other, while maintaining shared UI state.

## UI State Ownership
- UI state is centralized in the main process and broadcast to renderers.
- Renderer hydrates from IPC and mirrors state locally.
- State includes: `mode` (Ask/Chat/Voice), `window` (Full/Mini), and `conversationId`.

## IPC Channels (current)
- `ui:getState` -> fetch shared UI state
- `ui:setState` -> update shared UI state
- `ui:state` -> broadcast state updates
- `window:show` -> switch between Full/Mini windows

## AI Agents
- General Agent handles user tasks using tools and screens.
- Self-Modification Agent edits the platform itself with tracked changes.
- Both are invoked from the renderer via the Model Gateway (server-side only).

## Agent System Notes
- Stella uses a single default home directory at `~/.stella`.
- The local host scans `~/.stella/{agents,skills,plugins}` and syncs manifests to the backend.
- Task delegation (`Task`, `TaskOutput`) is handled server-side, while device and plugin tools run on the local host.
