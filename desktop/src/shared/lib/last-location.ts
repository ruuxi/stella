/**
 * Renderer-side persistence for the last-visited router location.
 *
 * We persist the active route path + search to `localStorage` (which Electron
 * backs by an on-disk store inside the user-data directory) so a fresh launch
 * can restore where the user was. This intentionally does *not* go through
 * `UiState`/IPC: no other window cares about it, and writing to main on
 * every navigation would be wasted IPC.
 */

const STORAGE_KEY = 'stella:lastLocation'

/** Maximum bytes we will accept from storage. Prevents pathological values. */
const MAX_LENGTH = 2048

/** Read the persisted location, or `null` if missing/invalid/unavailable. */
export function readPersistedLastLocation(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    if (raw.length > MAX_LENGTH) return null
    if (!raw.startsWith('/')) return null
    return raw
  } catch {
    return null
  }
}

/** Persist the location. Silently noops on storage errors (private mode, etc.). */
export function writePersistedLastLocation(location: string): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    if (!location || location.length > MAX_LENGTH) return
    window.localStorage.setItem(STORAGE_KEY, location)
  } catch {
    /* swallow quota / access errors */
  }
}
