# Frontend

Electron + React/Vite app. Two processes: main (`electron/main.ts`, ESM) and renderer (`src/`, Vite-bundled).

## Commands

```bash
bun run dev              # Vite dev server (React only)
bun run electron:dev     # Full Electron + Vite dev mode
bun run test             # Vitest watch mode
bun run test:run         # Vitest single run
bun run lint             # ESLint
bun run electron:build   # Package for distribution
```

## Storage

Chats, event transcripts, and agent/runtime state are stored locally in the Electron layer.

## Platform

Always handle both Windows and MacOS when implementing.

## Self-Modifying

Stella Agent can edit the frontend when requested. Possible due to remaining a dev server with Vite HMR, not a packaged desktop app.

## Conventions

- **Path alias**: `@/*` maps to `src/`
- **Tests**: repo-level tests live under `tests/` (`tests/renderer`, `tests/electron`, `tests/packages`, `tests/stella-browser`, and shared helpers in `tests/support`)
- **Preload is CommonJS** (`tsconfig.preload.json`), main process is ESM (`tsconfig.electron.json`)
- **IPC**: `window.electronAPI` via preload `contextBridge`, typed in `src/types/electron.d.ts`
- **Components**: Radix UI primitives, paired `.tsx` + `.css`, variants via `data-*` attributes (not className), use `cn()` for Tailwind + component CSS
- **Theming**: OKLCH color space, CSS custom properties on `:root`
