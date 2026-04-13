# Stella Development Guide

## Cursor Cloud specific instructions

### Project overview

Stella is an AI-powered personal assistant delivered as an Electron desktop app. The codebase has two main packages:

- **`desktop/`** — Electron + Vite + React 19 renderer (package manager: **npm**, lockfile: `package-lock.json`)
- **`backend/`** — Convex serverless backend (package manager: **bun**, lockfile: `bun.lock`)

### Dependency installation

- Desktop: `cd desktop && npm install --legacy-peer-deps` (required due to `vite@8` / `@tailwindcss/vite` peer dep conflict)
- Backend: `cd backend && bun install`
- Bun must be installed (`curl -fsSL https://bun.sh/install | bash`) — it is not included in the base VM image.

### Running services

| Service | Command | Port / Notes |
|---------|---------|-------------|
| Vite dev server | `cd desktop && npm run dev` | `http://localhost:57314` |
| Convex backend | `cd backend && bun run dev` (i.e. `convex dev`) | Requires Convex auth — run `npx convex dev` and follow login prompts |
| Electron app | `cd desktop && npm run electron:dev` | Loads renderer from Vite dev server; start Vite first |

### Lint / Test / Build

| Task | Command | Notes |
|------|---------|-------|
| Lint (desktop) | `cd desktop && npx eslint .` | Pre-existing lint errors in repo (~116 errors); these are not setup issues |
| Tests (desktop) | `cd desktop && npx vitest run` | 16/22 test files pass; 6 failures are pre-existing (missing module exports, not env issues) |
| Build (desktop renderer) | `cd desktop && npx vite build` | Builds the Vite renderer bundle |
| TypeScript check (electron) | `cd desktop && npm run electron:typecheck` | Checks electron + preload tsconfigs |
| Format check | `cd desktop && npm run format:check` | Uses Prettier via bunx |

### Gotchas

- The Vite dev server writes its URL to `desktop/.vite-dev-url` so the Electron main process can discover it. If the Electron app can't connect, check this file exists.
- The app is designed to run inside Electron. Viewing `http://localhost:57314` in a regular browser will show a blank page since many features depend on `window.electronAPI` (IPC bridge).
- The backend requires Convex Cloud authentication. Without `convex dev` logged in, backend functions won't be available.
- `desktop/trustedDependencies` in `package.json` lists native packages that need build steps (electron, esbuild, dugite, etc.). These are handled by npm's trust mechanism.
