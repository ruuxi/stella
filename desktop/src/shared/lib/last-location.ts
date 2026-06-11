/**
 * Renderer-side persistence for the last-visited router location.
 *
 * We persist the active route path + search to the shared UI state store
 * (~/.stella/ui-state.json) so a fresh launch can restore where the user was.
 */

import { uiState } from '@/platform/ui-state'

const STORAGE_KEY = 'stella:lastLocation'

/** Maximum bytes we will accept from storage. Prevents pathological values. */
const MAX_LENGTH = 2048

/** Read the persisted location, or `null` if missing/invalid/unavailable. */
export function readPersistedLastLocation(): string | null {
  const raw = uiState.getItem(STORAGE_KEY)
  if (!raw) return null
  if (raw.length > MAX_LENGTH) return null
  if (!raw.startsWith('/')) return null
  return raw
}

/** Persist the location. */
export function writePersistedLastLocation(location: string): void {
  if (!location || location.length > MAX_LENGTH) return
  uiState.setItem(STORAGE_KEY, location)
}
