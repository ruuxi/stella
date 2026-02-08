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

UI state (`UiState`) with `mode` (chat/voice), `view` (chat/store), and `window` (full/mini) is synchronized across windows via IPC broadcast.

### Backend Integration

- **Convex**: Real-time backend via `convex` package. Client configured in `src/services/convex-client.ts`. Requires `VITE_CONVEX_URL` environment variable.
- **Model Gateway**: SSE streaming chat endpoint at `/api/chat` on the Convex HTTP site (`src/services/model-gateway.ts`).
- **AI SDK**: Uses `@ai-sdk/react` and `ai` packages for chat interactions.

### Local Host System

The main process runs a "local host" (`electron/local-host/`) that:
- Generates a persistent device ID (`device.ts`)
- Polls Convex for tool requests targeted at this device (`runner.ts`)
- Executes tools locally and sends results back (`tools.ts`)
- Syncs skills, agents, and plugins from `~/.stella/` to Convex (`skills.ts`, `agents.ts`, `plugins.ts`)

See `electron/local-host/CLAUDE.md` for detailed tool system documentation.

### Theming

Custom theme system in `src/theme/`:
- `ThemeProvider` manages theme, color mode (light/dark/system), and gradient settings
- Themes define light/dark color palettes
- Colors are applied as CSS custom properties on `:root`
- Uses OKLCH color space for gradient generation (`color.ts`)

### UI Components

Components in `src/components/` are built on Radix UI primitives with custom styling. Component index at `src/components/index.ts`.

See `src/components/CLAUDE.md` for component conventions.

### Canvas System

Side panel for rendering AI-generated content alongside chat:
- **State**: `src/app/state/canvas-state.tsx` — `CanvasProvider`, `useCanvas` hook
- **Panel**: `src/components/canvas/CanvasPanel.tsx` — panel with resize handle, header, close button
- **6 renderers** in `src/components/canvas/renderers/`: data_table, chart, json_viewer, proxy, panel, appframe
- **Panel renderer**: Vite-compiled single-file TSX from `workspace/panels/` via dynamic import
- **Workspace apps**: Full Vite+React projects in `workspace/apps/`, scaffolded via `workspace/create-app.js`
- **Event bridge**: `src/hooks/use-canvas-commands.ts` — processes canvas events from Convex
- **CSS**: `src/styles/canvas-panel.css` + `src/styles/canvas-renderers.css`

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
