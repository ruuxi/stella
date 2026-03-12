# Stella Renderer Structure

Use these top-level folders as the default placement rules for renderer changes:

- `app/`: User-facing app surfaces and their app-local pages. Examples: `home`, `chat`, `workspace`.
- `global/`: Cross-app surfaces that are always available or launched from shell controls. Examples: `settings`, `auth`, `integrations`, `onboarding`.
- `shell/`: Window chrome and app hosting. This owns `FullShell`, `MiniShell`, overlay UI, sidebar, header tabs, and shell-only helpers.
- `systems/`: Background boot and always-on runtime roots. Examples: app bootstrap hooks and voice runtime roots.
- `features/`: Reusable product capabilities that are not navigable apps on their own. Examples: `voice`, `music`.
- `shared/`: Truly cross-cutting contracts, hooks, utilities, or components used across multiple areas of the renderer.
- `ui/`: Generic design-system primitives.

Placement rules:

- Prefer keeping code local to the app, global surface, or shell that owns it.
- Only move code into `shared/` when it is genuinely reused across boundaries.
- Only add subfolders when there is a real seam. Avoid generic buckets like `services/` unless a folder has enough internal complexity to justify them.
- Put navigable app code under `src/app/`.
- Do not use `src/apps/`. That was a temporary rename during the ongoing structure refactor.

Navigation model:

- Sidebar is for app-level or global entry points.
- Header tabs represent pages within the current app or workspace.
- Shell should host apps and global surfaces, not hardcode product logic that belongs inside them.
