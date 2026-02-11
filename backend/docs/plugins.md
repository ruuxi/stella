# Plugins

Plugin support is currently removed from the backend runtime.

## Current Status

- Dynamic plugin tool loading is disabled.
- Plugin metadata tables are removed from schema:
  - `plugins`
  - `plugin_tools`
- Plugin package type is removed from backend validators/tool schemas.
- Store and package-management flows now support: `skill`, `theme`, `canvas`, `mod`.

## Why This Is Documented

This file is a checkpoint so plugin support can be reintroduced intentionally later without guessing prior behavior.

## Re-Enable Checklist

1. Restore schema tables:
   - `plugins`
   - `plugin_tools` (with per-owner indexes and JSON schema payload)
2. Recreate backend module for plugin data ops:
   - `convex/data/plugins.ts`
   - `upsertMany`
   - descriptor list query for runtime tool assembly
3. Restore dynamic tool assembly in `convex/tools/index.ts`:
   - load plugin descriptors
   - convert JSON schema to Zod
   - map to device tool execution
4. Restore runtime wiring:
   - `convex/http.ts`
   - `convex/agent/tasks.ts`
   - `convex/agent/invoke.ts`
   - `convex/automation/runner.ts`
5. Restore plugin type in store validators if needed:
   - `convex/schema.ts`
   - `convex/data/store_packages.ts`
   - `convex/tools/backend.ts` (`StoreSearch` type enum)
   - `convex/agent/device_tools.ts` (`ManagePackage` schemas)
6. Regenerate Convex types:
   - `bunx convex codegen`
7. Add/restore tests:
   - plugin descriptor query behavior
   - tool allowlist filtering with plugin tools
   - end-to-end execution path for plugin-provided tool calls

## Notes

- If you re-enable plugin tables in an existing deployment, plan a migration for any store/package data shape changes first.
- Keep tool allowlists explicit; avoid implicit runtime widening when reintroducing plugin tools.
