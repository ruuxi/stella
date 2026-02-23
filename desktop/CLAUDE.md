# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev              # Vite dev server (React only, HMR)
bun run electron:dev     # Full Electron + Vite dev mode
bun run test             # Run Vitest tests (watch mode)
bun run test:run         # Run tests once
bun run lint             # ESLint
bun run electron:build   # Package for distribution
```

## Path Aliases

Use `@/*` to import from `src/`:
```typescript
import { Button } from "@/components/button"
import { useTheme } from "@/theme/theme-context"
```

## Architecture

### Two-Process Model

- **Main Process** (`electron/main.ts`): Node.js process that creates windows and handles system-level operations. Compiled to `dist-electron/` using `tsconfig.electron.json`.
- **Renderer Process** (`src/`): React application running in Chromium. Bundled by Vite to `dist/`.

### IPC Communication

The preload script (`electron/preload.ts`) uses `contextBridge` to safely expose APIs to the renderer. Access exposed APIs via `window.electronAPI` in React components (typed in `src/types/electron.d.ts`).

Note: The preload script uses CommonJS (`tsconfig.preload.json`) while main process uses ESM (`tsconfig.electron.json`).

### Multi-Window Architecture

The app has four window types, determined by `?window=` query parameter:
- **Full** (`FullShell.tsx`): Main application window with full chat interface
- **Mini** (`MiniShell.tsx`): Spotlight-style overlay for quick interactions (frameless, always-on-top, hides on blur)
- **Radial** (`RadialShell.tsx`): Transparent overlay for the radial menu
- **Region** (`RegionCapture.tsx`): Region capture overlay window

UI state (`UiState`) with `mode` (chat/voice), `view` (chat/store), and `window` (full/mini/voice) is synchronized across windows via IPC broadcast.

### Backend Integration

- **Convex**: Real-time backend via `convex` package. Client configured in `src/services/convex-client.ts`. Requires `VITE_CONVEX_URL` environment variable.
- **Model Gateway**: SSE streaming chat endpoint at `/api/chat` on the Convex HTTP site (`src/services/model-gateway.ts`).
- **AI SDK**: `ai` package in dependencies (used only by build-time utility scripts, not runtime).

### Local Host System

The main process runs a "local host" (`electron/local-host/`) that:
- Generates a persistent device ID (`device.ts`)
- Polls Convex for tool requests targeted at this device (`runner.ts`)
- Executes tools locally and sends results back (`tools.ts`)
- Syncs skills and agents from `~/.stella/` to Convex (`skills.ts`, `agents.ts`)

See `electron/local-host/CLAUDE.md` for tool handler patterns.

### Theming

Custom theme system in `src/theme/`:
- `ThemeProvider` manages theme, color mode (light/dark/system), and gradient settings
- Themes define light/dark color palettes
- Colors are applied as CSS custom properties on `:root`
- Uses OKLCH color space for gradient generation (`color.ts`)

### UI Components

Components in `src/components/` are built on Radix UI primitives with custom styling. Re-exported from `src/components/index.ts`.

Conventions:
- Paired `.tsx` + `.css` files per component
- Reusable primitives: lowercase with hyphens (`dropdown-menu.tsx`); app-level: PascalCase (`Sidebar.tsx`)
- Variants via `data-*` attributes, not className props
- Always use Radix primitives for dialogs, dropdowns, popovers, tooltips, selects
- Tailwind utilities combined with component CSS using `cn()`

### Workspace-Primary Layout

The app uses a workspace-primary layout: `[Sidebar 220px] [WorkspaceArea flex:1] [ChatPanel animated-width]`

- **State**: `src/app/state/workspace-state.tsx` — `WorkspaceProvider`, `useWorkspace` hook. `canvas === null` means dashboard.
- **WorkspaceArea**: `src/components/workspace/WorkspaceArea.tsx` — always visible center area, routes: store | canvas | dashboard | onboarding
- **ChatPanel**: `src/components/chat/ChatPanel.tsx` — collapsible right panel with resize handle
- **Canvas renderers**: `src/components/canvas/renderers/panel.tsx` (Vite-compiled TSX from `workspace/panels/`), `renderers/appframe.tsx` (sandboxed iframe for workspace apps)
- **Error boundary**: `src/components/canvas/CanvasErrorBoundary.tsx`
- **Workspace apps**: Full Vite+React projects in `~/.stella/apps/`, scaffolded via `workspace/create-app.js`
- **Backend tools**: `OpenCanvas(name, title?, url?)` and `CloseCanvas()` — emit canvas_command events
- **Event bridge**: `src/hooks/use-canvas-commands.ts` — uses `useWorkspace`
- **CSS**: `src/styles/workspace.css` + `src/styles/chat-panel.css` + `src/styles/canvas-renderers.css`

### Store

App store for browsing, installing, and managing skills and themes:
- **UI**: `src/screens/full-shell/StoreView.tsx` — lazy-loaded from FullShell
- **View routing**: `ViewType = 'chat' | 'store'` in UiState, toggled from sidebar
- **CSS**: `src/styles/store.css`

### Build Output

- `dist/`: Vite-bundled React app (loaded by Electron in production)
- `dist-electron/`: Compiled Electron main process code
- `release/`: Packaged application installers (created by electron-builder)

## Testing

Tests use Vitest with React Testing Library:
- Unit tests in `__tests__/` directories or `*.test.ts` files
- Run `bun run test` for watch mode during development
- Run `bun run test:run` for CI/single run
