# Plugins (Disabled)

Frontend plugin loading/installation is currently removed.

## Current behavior

- The local host only syncs `~/.stella/skills` and `~/.stella/agents`.
- No plugin manifests are loaded from `~/.stella/plugins`.
- Store install paths support `skill`, `theme`, `canvas`, and `mod` (no `plugin`).
- The renderer IPC surface does not expose plugin install APIs.

## Re-enable checklist

1. Restore a plugin loader module under `electron/local-host/` and wire it into `tools.ts`.
2. Add plugin sync mutation(s) in backend and re-register plugin tool descriptors.
3. Re-add plugin install handling in `electron/local-host/tools_store.ts`.
4. Re-add `store:installPlugin` IPC handlers in `electron/main.ts` and `electron/preload.ts`.
5. Re-add renderer typings in `src/types/electron.d.ts` and UI install flow in `src/screens/full-shell/StoreView.tsx`.
6. Restore `~/.stella/plugins` directory handling in `electron/local-host/stella-home.ts`.
