# State Ownership

Which process owns each piece of shared state, and how it flows across IPC.

## Sync pattern

Stella uses an **asymmetric request-broadcast** model:

1. **Renderer** sends a state change request via `window.electronAPI.ui.setState()`.
2. **Main process** (`UiStateService`) applies the change to its canonical copy.
3. **Main process** broadcasts the full `UiState` to all windows via `ui:state` IPC.
4. **Renderer** receives the broadcast and updates React context.

The renderer never applies changes locally first — it always waits for the
authoritative broadcast from Main. A hydration guard
(`hasHydratedFromMainRef` in `ui-state.tsx`) prevents race conditions during
initial sync.

## State domains

### UI State (`UiState`)


| Field                                        | Source of truth         | Written by                                                      | Read by                                              |
| -------------------------------------------- | ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `mode` (`chat` | `voice`)                    | Main (`UiStateService`) | Renderer via `setState`, Main via `activateVoiceRtc()`          | Renderer context, Main (overlay logic)               |
| `window` (`full` | `mini`)                   | Main (`UiStateService`) | Renderer via `setState` + `window:show`, Main via IPC handler   | Renderer context, WindowManager                      |
| `conversationId`                             | Main (`UiStateService`) | Renderer via `setState`, Main via `activateVoiceRtc()`          | Renderer context, VoiceRuntimeRoot                    |
| `isVoiceRtcActive`                           | Main (`UiStateService`) | Main only — via `activateVoiceRtc()` / `deactivateVoiceModes()` | Renderer context, overlay sync                        |

> **Note (TanStack Router migration)**: The active *view* (which app is on
> screen) used to live in `UiState.view`. It now lives in the router. The
> router uses `createMemoryHistory()`. The full-shell renderer persists its
> last router location to `localStorage` (key `stella:lastLocation`) so it
> can restore on the next launch — *not* through `UiState`/IPC, because no
> other window cares. See `desktop/src/shared/lib/last-location.ts` and
> the restore/persist effects in `desktop/src/routes/__root.tsx`. Adding a
> new sidebar app is "drop a folder under `desktop/src/apps/<id>/`" — see
> `state/skills/stella-desktop/SKILL.md`.


### conversationId — detailed flow

This is the most complex piece of state because two subsystems interact:

1. **Canonical source**: the chat route's `?c=<id>` search param
   (`/chat?c=<id>`). The chat App (`apps/chat/App.tsx`) reads the param via
   `useSearch({ from: '/chat' })`.
2. **Cross-window mirror**: `useConversationBootstrap` writes the
   bootstrapped id into `UiState.conversationId` so the **voice overlay
   window** (which has no router) can read it. The chat route also keeps
   `UiState.conversationId` in sync via `setConversationId(...)` whenever
   `?c=<id>` changes.
3. **Voice runtime**: `VoiceRuntimeRoot` reads `state.conversationId` from
   context and forwards it to the voice session manager. It does NOT write
   back to UiState — it is a consumer, not an owner. It has a local
   `bootConversationId` used only to resolve the ID before the first render
   via `localChat.getOrCreateDefaultConversationId()`.

### isVoiceRtcActive — special rules

Only Main can set this to `true` (via `activateVoiceRtc`). The renderer can
request deactivation, but activation is gated through Main because it requires
coordinating overlay visibility and mobile bridge sync.

Side effects triggered by changes:

- `syncVoiceOverlay()` — shows/hides voice overlay window.
- Broadcast to all windows + mobile bridge.

### Theme


| Field                                                   | Source of truth           | Sync                                                                  |
| ------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `themeId`, `colorMode`, `gradientMode`, `gradientColor` | Renderer (`localStorage`) | Renderer persists → broadcasts to Main → Main relays to other windows |


Theme is **renderer-owned**. Main never maintains its own theme state — it
only relays changes between windows. This is intentionally different from
UiState (which is Main-owned).

### Chat store mode


| Field                             | Source of truth                        |
| --------------------------------- | -------------------------------------- |
| `storageMode` (`cloud` | `local`) | Renderer (`ChatStoreProvider` context) |


Purely renderer-local. Synced to Main only when needed for agent runtime
configuration.

### Workspace


| Field                                  | Source of truth                        |
| -------------------------------------- | -------------------------------------- |
| `activePanel`, `chatWidth`, `chatOpen` | Renderer (`WorkspaceProvider` context) |


Purely renderer-local. No IPC sync.

## IPC authorization

From `electron/ipc/ui-handlers.ts`:

- **Privileged** (requires `assertPrivilegedSender`): `ui:setState`, `window:show`, `app:reload`, `app:setReady`
- **Public** (read-only): `ui:getState`, `window:isMaximized`
- **Window-scoped** (operates on sender window): `window:minimize`, `window:maximize`, `window:close`