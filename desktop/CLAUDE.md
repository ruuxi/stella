# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stellar is an Electron desktop application built with React 19, TypeScript, and Vite. It uses bun as the package manager.

## Commands

```bash
# Install dependencies
bun install

# Development - Vite only (web browser)
bun run dev

# Development - Electron app with hot reload
bun run electron:dev

# Build for production
bun run electron:build

# Preview production build in Electron
bun run electron:preview

# Lint
bun run lint
```

## Architecture

### Two-Process Model

- **Main Process** (`electron/main.ts`): Node.js process that creates windows and handles system-level operations. Compiled to `dist-electron/` using `tsconfig.electron.json`.
- **Renderer Process** (`src/`): React application running in Chromium. Bundled by Vite to `dist/`.

### IPC Communication

The preload script (`electron/preload.ts`) uses `contextBridge` to safely expose APIs to the renderer. Access exposed APIs via `window.electronAPI` in React components.

### TypeScript Configuration

- `tsconfig.json`: References app and node configs
- `tsconfig.app.json`: React/renderer code
- `tsconfig.node.json`: Vite config
- `tsconfig.electron.json`: Electron main/preload (outputs ESM to `dist-electron/`)

### Build Output

- `dist/`: Vite-bundled React app (loaded by Electron in production)
- `dist-electron/`: Compiled Electron main process code
- `release/`: Packaged application installers (created by electron-builder)
