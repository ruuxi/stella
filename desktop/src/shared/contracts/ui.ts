export type UiMode = 'chat' | 'voice'

export type WindowMode = 'full' | 'mini'

/**
 * `UiState` is the small slice of UI status that is shared across processes
 * (main + every renderer window) via IPC. It is the *only* state shared
 * cross-process; everything else lives in renderer-local React state.
 *
 * As of the TanStack Router migration, the active "view" is owned by the
 * router (not by `UiState.view`). The full-shell renderer persists its last
 * router location into renderer-side `localStorage` (key
 * `stella:lastLocation`) so the app can reopen on the same route. We do
 * *not* round-trip that through `UiState` — no other window cares, and IPC
 * on every navigation is wasted bandwidth.
 *
 * `conversationId` remains in `UiState` because the voice overlay window
 * needs cross-window access to the active conversation. The chat route
 * (`app/chat/App.tsx`) is the *writer* — search-param `?c=<id>` is the
 * canonical source of truth; UiState mirrors it. No other window writes it
 * outside of voice activation in the main process.
 */
export type UiState = {
  mode: UiMode
  window: WindowMode
  conversationId: string | null
  isVoiceRtcActive: boolean
  suppressNativeRadialDuringOnboarding: boolean
}
