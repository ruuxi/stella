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

| Field | Source of truth | Written by | Read by |
|---|---|---|---|
| `mode` (`chat` \| `voice`) | Main (`UiStateService`) | Renderer via `setState`, Main via `activateVoiceRtc()` | Renderer context, Main (overlay logic) |
| `window` (`full` \| `mini`) | Main (`UiStateService`) | Renderer via `setState` + `window:show`, Main via IPC handler | Renderer context, WindowManager |
| `view` (`app` \| `chat` \| `store` \| `social`) | Main (`UiStateService`) | Renderer via `setState` | Renderer context (navigation) |
| `conversationId` | Main (`UiStateService`) | Renderer via `setState`, Main via `activateVoiceRtc()` | Renderer context, VoiceRuntimeRoot, Main (wake-word) |
| `isVoiceRtcActive` | Main (`UiStateService`) | Main only — via `activateVoiceRtc()` / `deactivateVoiceModes()` | Renderer context, overlay sync, wake-word scheduler |

### conversationId — detailed flow

This is the most complex piece of state because three subsystems interact:

1. **Normal flow**: Renderer calls `setConversationId()` → Main updates →
   Main broadcasts → all windows receive.
2. **Wake-word flow**: Electron wake-word detector fires → Main calls
   `activateVoiceRtc(conversationId)` → Main sets conversationId + mode +
   isVoiceRtcActive → broadcasts.
3. **Voice runtime**: `VoiceRuntimeRoot` reads `state.conversationId` from
   context and forwards it to the voice session manager. It does NOT write
   back to UiState — it is a consumer, not an owner. It has a local
   `bootConversationId` used only to resolve the ID before the first render
   via `localChat.getOrCreateDefaultConversationId()`.

### isVoiceRtcActive — special rules

Only Main can set this to `true` (via `activateVoiceRtc`). The renderer can
request deactivation, but activation is gated through Main because it requires
coordinating overlay visibility, wake-word suspension, and mobile bridge sync.

Side effects triggered by changes:
- `syncVoiceOverlay()` — shows/hides voice overlay window.
- `scheduleResumeWakeWord()` — resumes wake-word detection after a delay.
- Broadcast to all windows + mobile bridge.

### Theme

| Field | Source of truth | Sync |
|---|---|---|
| `themeId`, `colorMode`, `gradientMode`, `gradientColor` | Renderer (`localStorage`) | Renderer persists → broadcasts to Main → Main relays to other windows |

Theme is **renderer-owned**. Main never maintains its own theme state — it
only relays changes between windows. This is intentionally different from
UiState (which is Main-owned).

### Chat store mode

| Field | Source of truth |
|---|---|
| `storageMode` (`cloud` \| `local`) | Renderer (`ChatStoreProvider` context) |

Purely renderer-local. Synced to Main only when needed for agent runtime
configuration.

### Workspace

| Field | Source of truth |
|---|---|
| `activePanel`, `chatWidth`, `chatOpen` | Renderer (`WorkspaceProvider` context) |

Purely renderer-local. No IPC sync.

## IPC authorization

From `electron/ipc/ui-handlers.ts`:

- **Privileged** (requires `assertPrivilegedSender`): `ui:setState`, `window:show`, `app:reload`, `app:setReady`
- **Public** (read-only): `ui:getState`, `window:isMaximized`
- **Window-scoped** (operates on sender window): `window:minimize`, `window:maximize`, `window:close`
