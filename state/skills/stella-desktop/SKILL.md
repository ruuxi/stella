---

## name: stella-desktop

description: How Stella's own Electron desktop app is structured — processes, routing, sidebar apps, dialogs, UI state — so the agent can self-modify it without guessing.

# Modifying Stella Desktop

`desktop/` is the Stella product itself: an Electron app with a React renderer
and a TanStack file-system router. This skill is a map of where things live
and the small set of patterns that handle ~90% of UI changes the agent is
asked to make. **Use it before editing `desktop/src/`** — most "where do I put
this?" answers are here.

> Co-located guidance: `desktop/src/STELLA.md` is the placement guide for
> renderer code (which folder for which kind of code). Read both — this skill
> is the *task-shaped* version, `STELLA.md` is the *bucket-shaped* version.

## Process model (the three Electron processes)

Stella runs as three cooperating processes. Knowing which one to edit is the
single biggest source of agent confusion, so start here.


| Process                      | Code under                                  | What it does                                                                             | Globals available                                                                                   |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Main**                     | `desktop/electron/`                         | Owns windows, IPC, file system, native APIs, the canonical `UiState`, the runtime kernel | Node + Electron only — no DOM, no React                                                             |
| **Renderer (full shell)**    | `desktop/src/` (entry: `main.tsx`)          | The full app UI — sidebar, chat, settings, all routes                                    | Browser DOM + React + Vite-bundled                                                                  |
| **Renderer (voice overlay)** | `desktop/src/` (entry: `overlay-entry.tsx`) | Tiny always-on-top window that shows the voice orb. **Has no router.**                   | Browser DOM + React, but reads `UiState` for the conversationId because it has no router to hold it |


Renderer ↔ Main talks via `window.electronAPI.`* (preload bridge) → IPC
handlers under `desktop/electron/ipc/`. Read `desktop/STATE_OWNERSHIP.md`
before changing anything that crosses the boundary.

## Routing (TanStack Router, file-system mode)

Stella uses **TanStack Router** with **memory history** (no URL bar in
Electron). Routes live in `desktop/src/routes/` and are compiled to
`desktop/src/routeTree.gen.ts` by the Vite plugin.


| File                            | Purpose                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop/src/router.tsx`        | Creates the router with memory history starting at `/chat`.                                                                                |
| `desktop/src/routes/__root.tsx` | Root layout. Renders the global chrome (Sidebar, dialogs, floating ChatSidebar / DisplaySidebar) and an `<Outlet />` for the active route. |
| `desktop/src/routes/index.tsx`  | Redirects `/` → `/chat`.                                                                                                                   |
| `desktop/src/routes/<id>.tsx`   | One-line shell per app: declares `createFileRoute('/<id>')` + the component.                                                               |
| `desktop/src/routeTree.gen.ts`  | **Auto-generated. Do not edit.** Vite's `TanStackRouterVite` plugin regenerates it on file change.                                         |


### The renderer never reads `pathname` from `window.location`

Always use the router hooks:

- `useNavigate()` to navigate.
- `useMatchRoute()({ to: '/chat' })` to ask "is the user on /chat?".
- `useSearch({ from: '/chat' })` to read typed search params (validated by zod
in the route file).
- `useRouterState({ select: (s) => s.location.pathname })` if you need the
raw pathname (e.g. to close a drawer on every route change).

### Search params are zod-validated and the canonical place for transient state


| Route       | Param                 | Why                                                                 |
| ----------- | --------------------- | ------------------------------------------------------------------- |
| `__root`    | `?dialog=auth         | connect`                                                            |
| `/chat`     | `?c=<conversationId>` | The conversation id lives in the URL so refresh/restore Just Works. |
| `/settings` | `?tab=basic           | models                                                              |


Adding a new search param means: edit the route file's zod schema → use
`useSearch({ from: '/<route>' })` to read it → use `navigate({ to, search })`
to write it.

### Persisted location

The full-shell renderer persists the last router location to renderer-side
`localStorage` (key `stella:lastLocation`, helper module
`@/shared/lib/last-location`). `__root.tsx` writes it on every router
resolution and reads it back exactly once on first mount, validating the
pathname against `router.routesByPath` before navigating. This is *not* in
`UiState`/IPC — no other window cares, and avoiding the IPC round-trip
keeps navigation cheap. Agents should not touch this directly; let the root
layout do it.

## Adding a new sidebar app (the most common change)

This is exactly three files. **Do not edit the Sidebar component.** It picks
the new app up automatically through `import.meta.glob`.

### 1. `desktop/src/apps/<id>/metadata.ts`

```ts
import { CustomLayout } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "notes",
  label: "Notes",
  icon: CustomLayout,
  route: "/notes",
  slot: "top",        // "top" or "bottom"
  order: 30,          // smaller = higher in the slot
  // optional — fires when the user clicks the entry while it's already active
  // onActiveClick: () => dispatchScrollToTop(),
};

export default metadata;
```

### 2. `desktop/src/apps/<id>/App.tsx`

```tsx
import { lazy, Suspense } from "react";
import { Spinner } from "@/ui/spinner";

const NotesView = lazy(() => import("@/global/notes/NotesView"));

export function NotesApp() {
  return (
    <div className="workspace-area">
      <div className="workspace-content workspace-content--full">
        <Suspense
          fallback={
            <div className="workspace-placeholder">
              <Spinner size="md" />
            </div>
          }
        >
          <NotesView />
        </Suspense>
      </div>
    </div>
  );
}

export default NotesApp;
```

### 3. `desktop/src/routes/<id>.tsx`

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { NotesApp } from "@/apps/notes/App";

export const Route = createFileRoute("/notes")({
  component: NotesApp,
});
```

That's it. Restart Vite dev (or rely on HMR), and the new entry shows up in
the sidebar. Run the runtime tests to confirm:

```bash
cd desktop && bunx vitest@4.0.18 run --project runtime tests/runtime/sidebar-discovery.test.ts tests/runtime/route-smoke.test.ts
```

`tests/runtime/sidebar-discovery.test.ts` verifies every `apps/<id>/metadata.ts`
is well-formed and has a matching `routes/<id>.tsx`. `route-smoke.test.ts`
verifies the generated route tree references it.

## Adding a route-level search param

Edit the route file:

```tsx
import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { NotesApp } from "@/apps/notes/App";

const NotesSearch = z.object({
  noteId: z.string().optional(),
});

export const Route = createFileRoute("/notes")({
  validateSearch: NotesSearch,
  component: NotesApp,
});
```

Then in the component:

```tsx
const search = useSearch({ from: "/notes" });
const navigate = useNavigate();

// read
const id = search.noteId;

// write (replace = no history entry)
void navigate({ to: "/notes", search: { noteId: "abc" }, replace: true });
```

## Adding a new dialog

Two patterns — pick based on whether it should be deep-linkable.

### Pattern A: a global dialog reachable from anywhere (preferred)

Treat the dialog as URL state under the root route. This is how `Auth` and
`Connect` work today.

1. Extend the root zod enum in `desktop/src/routes/__root.tsx`:
  ```ts
   const RootSearch = z.object({
     dialog: z.enum(["auth", "connect", "share"]).optional(),
   });
  ```
2. Add the lazy-loaded dialog in `desktop/src/shell/full-shell-dialogs.tsx`,
  following the existing `AuthDialog` / `ConnectDialog` pattern.
3. Open it with `navigate({ to: '.', search: (prev) => ({ ...prev, dialog: 'share' }) })`.

### Pattern B: a route-local dialog

Use plain React state inside the route component. Don't bother with the URL
unless deep-linking matters.

## UiState vs router state — what goes where

`UiState` is the **canonical Main-owned state** broadcast to all renderer
windows. The router lives **inside the full-shell renderer only**. They have
different jobs.


| Goes in `UiState` (`desktop/src/shared/contracts/ui.ts`)               | Goes in the router                           |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| State the voice overlay (no router) needs                              | The active app/view (which route)            |
| State the Main process needs (overlay logic, voice activation)         | Per-route deep-linkable params               |
| Cross-window sync (e.g. `mode`, `window`, `isVoiceRtcActive`)          | Dialog open/close (when global)              |
| `conversationId` — mirrored here so the overlay can read it            | `?c=<id>` on `/chat` is the canonical source |
| (none — `lastLocation` is renderer-only `localStorage`, not `UiState`) | Everything else navigation-shaped            |


If the only consumer is one screen and there is no cross-window or deep-link
need, prefer **plain React state** — neither.

> Fast rule of thumb: *if the voice overlay window needs to read it,* it
> belongs in `UiState`. *If the user can paste it into a deep link,* it
> belongs in the router. Otherwise it's local state.

## Hoisted chat runtime (`ChatRuntimeProvider`)

`useFullShellChat()` produces the chat conversation, composer, streaming, etc.
That hook runs **once** in `__root.tsx` inside `<ChatRuntimeProvider>`. Both
the chat route (`apps/chat/App.tsx`) and the floating sidebars
(`ChatSidebar`, `DisplaySidebar`) consume it via `useChatRuntime()`. Don't
mount `useFullShellChat` anywhere else — that would double-instantiate the
streaming subscription.

## Lazy loading + Suspense

Heavy views (`StoreView`, `SocialView`, `SettingsScreen`, `NotesView`, …)
are `lazy()`-loaded inside the per-app `App.tsx` and wrapped in `<Suspense>`.
Follow that pattern for any new view bigger than a few KB. The router
component itself is **eager** — the `App` shell loads instantly and the
inner view streams in.

## Convex + the router

TanStack Router caching and Convex are **separate, non-conflicting** systems:

- The router caches *route components* and *loader data* keyed by URL.
- Convex caches *reactive query results* keyed by query+args, in the
`ConvexReactClient`, and updates them in real time.

Don't put Convex queries in router `loader` — you'd lose reactivity. Do
this:

```tsx
function NotesApp() {
  const notes = useQuery(api.notes.list); // reactive
  if (notes === undefined) return <Spinner />;
  return <NotesView notes={notes} />;
}
```

If you want a route loader, use it for *non-reactive* prefetch only (e.g.
asset preloads, third-party API calls).

## Common pitfalls

- **Editing `routeTree.gen.ts`.** It is regenerated on file change. Edit the
files in `routes/` instead.
- **Adding hardcoded sidebar entries.** The sidebar discovers apps via
`import.meta.glob`. Add `apps/<id>/metadata.ts` instead.
- **Reading `window.location.pathname`.** Use `useMatchRoute` or
`useRouterState`.
- **Calling `useFullShellChat` outside the root.** Use `useChatRuntime()`
to read the hoisted output.
- **Adding new fields to `UiState` reflexively.** Most "global state" is
actually router state or local state. Re-read the table above.
- **Forgetting the voice overlay has no router.** If your feature needs to be
reachable from the overlay, it has to go through `UiState`, not the
router.
- **Skipping zod on a search param.** Untyped search params are runtime
surprises waiting to happen.

## Testing & validation

Renderer code lives in two test environments declared in
`desktop/vitest.config.ts`:

```bash
cd desktop

bun run typecheck          # tsc -p tsconfig.json
bunx --package typescript@5.9.3 tsc -p tsconfig.electron.json --noEmit   # electron typecheck
bun run lint               # eslint
bunx vitest@4.0.18 run --project runtime    # node-env tests (most tests live here)
bunx vitest@4.0.18 run --project renderer   # jsdom-env tests (UI)
```

Sidebar/route invariants: `tests/runtime/sidebar-discovery.test.ts` and
`tests/runtime/route-smoke.test.ts` enforce the metadata contract and the
generated route tree.

`desktop/src/routeTree.gen.ts` is git-ignored, ESLint-ignored, and excluded
from formatters.

## Where to look first for common questions


| Question                                   | Read                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| "Where does this state live?"              | `desktop/STATE_OWNERSHIP.md`                                                        |
| "Where do I put this code?"                | `desktop/src/STELLA.md` (per-bucket guidance)                                       |
| "How do I add a sidebar app?"              | This file, *Adding a new sidebar app*                                               |
| "How do I open a dialog?"                  | This file, *Adding a new dialog*                                                    |
| "How do dialogs/auth/connect work?"        | `desktop/src/shell/full-shell-dialogs.tsx`, `desktop/src/routes/__root.tsx`         |
| "How does the voice overlay get its data?" | `desktop/STATE_OWNERSHIP.md`, *conversationId — detailed flow*                      |
| "How does the chat shell wire its hooks?"  | `desktop/src/context/chat-runtime.tsx` + `desktop/src/shell/use-full-shell-chat.ts` |


## Backlinks

- [Skills Index](../index.md)
- [registry](../../registry.md)
- [general-agent](../../../runtime/extensions/stella-runtime/agents/general.md)
- [renderer placement guide](../../../desktop/src/STELLA.md)
- [state ownership](../../../desktop/STATE_OWNERSHIP.md)

