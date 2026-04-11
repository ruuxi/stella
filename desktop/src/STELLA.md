# Stella Renderer Structure

Use this file as the default placement guide for renderer work in `src/`. It is a guide for where new code should live, not a complete dump of every file in the tree.

Core product buckets:

- `app/`: User-facing app surfaces and app-local pages. Examples: `chat`, `home`, `media`, `social`.
- `global/`: Cross-app surfaces that are always available or launched from shell controls. Examples: `settings`, `auth`, `integrations`, `onboarding`, `store`, `mobile`.
- `shell/`: Window chrome and app hosting. This owns shell layout, sidebar, context menus, overlay UI, header/tab containers, and shell-only helpers.
- `systems/`: Background boot and always-on runtime roots. Examples: app bootstrap and voice runtime roots.
- `features/`: Reusable product capabilities that are not navigable apps on their own. Examples: voice and music services/hooks.
- `shared/`: Truly cross-cutting contracts, hooks, utilities, components, theme, styles, and types used across multiple renderer areas.
- `ui/`: Generic design-system primitives with minimal product knowledge.

Support buckets:

- `context/`: App-wide React providers and shared state containers that are broader than a single app or panel, but still renderer-specific.
- `platform/`: Host and environment adapters for Electron, device integration, screenshots, and similar platform bridges.
- `infra/`: Low-level clients and wiring for external/runtime services used by the renderer.
- `prompts/`: Prompt templates, prompt catalog/transport helpers, and related prompt-side renderer code.
- `debug/`: Developer-facing debug surfaces and stores.
- `testing/`: Renderer-side test helpers, trace viewers, and self-mod test UI.
- `convex/`: Generated or shared Convex client surface used by the renderer. Do not treat this as a general feature bucket.

Entry files:

- Root entry files like `App.tsx`, `main.tsx`, and `overlay-entry.tsx` should stay thin and compose from the buckets above.

Placement rules:

- Prefer keeping code local to the app, global surface, shell area, or system that owns it.
- Put navigable app code under `src/app/`.
- Put cross-app product surfaces under `src/global/`.
- Keep shell code focused on hosting, layout, and navigation chrome. Do not move product-specific logic into `shell/` when it belongs inside `app/` or `global/`.
- Only move code into `shared/` when it is genuinely reused across boundaries.
- Use `ui/` for generic primitives; use `shared/` for Stella-specific shared building blocks, contracts, hooks, and foundations.
- Use `context/` for broad renderer state/providers. If state only serves one app or surface, keep it local instead.
- Use `platform/` and `infra/` for environment/service wiring, not feature ownership.
- Avoid generic buckets like `services/` or `utils/` at the top level. Add subfolders only when there is a real seam.
- Keep global renderer foundations under `src/shared/` rather than creating new top-level buckets for theme, style, or type concerns.
- If a subtree needs more specific guidance, add another `STELLA.md` in that subtree. Nearer `STELLA.md` files override broader parent guidance.

Navigation model:

- Sidebar is for app-level or global entry points.
- Header tabs represent pages within the current app or workspace.
- Shell should host apps and global surfaces, not hardcode product logic that belongs inside them.