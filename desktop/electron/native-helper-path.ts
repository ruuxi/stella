import { existsSync } from 'node:fs'
import path from 'node:path'

const __dirname = import.meta.dirname
const platformDir = process.platform === 'win32'
  ? 'win32'
  : process.platform === 'darwin'
    ? 'darwin'
    : process.platform

// Resolved helper locations never change within a run, so cache the first
// successful lookup per base name. This avoids re-running up to 4 synchronous
// existsSync stats on every hot-path helper invocation (selection probe,
// recent-apps, wakeword, parakeet) — each stat passes through the Windows
// antivirus minifilter and runs on the main thread. Only successful
// resolutions are cached forever, so a helper that is downloaded mid-session
// (e.g. via `native:download`) is still picked up on a later call.
const resolvedHelperPaths = new Map<string, string>()

// Absent helpers re-run the same up-to-4 existsSync stats on *every*
// poll-driven call (status/availability checks fire on timers even when the
// binary is missing), so cache negatives too — but only for a short TTL so a
// helper downloaded mid-session is re-statted soon after, and clear the whole
// negative cache outright on a `native:download` signal. Positive caching is
// unchanged.
const NEGATIVE_CACHE_TTL_MS = 30_000
const missingHelperUntil = new Map<string, number>()

/**
 * Forget all cached "helper absent" results so a freshly-downloaded helper is
 * re-statted immediately. Call this after a `native:download` completes.
 */
export const invalidateNativeHelperPathCache = (): void => {
  missingHelperUntil.clear()
}

export const resolveNativeHelperPath = (baseName: string): string | null => {
  const cached = resolvedHelperPaths.get(baseName)
  if (cached !== undefined) {
    return cached
  }

  // Skip the stat sweep if we recently confirmed this helper is absent.
  const missingUntil = missingHelperUntil.get(baseName)
  if (missingUntil !== undefined && Date.now() < missingUntil) {
    return null
  }

  const ext = process.platform === 'win32' ? '.exe' : ''
  const fileName = `${baseName}${ext}`
  const candidates = [
    // Packaged app: extraResources copies native/out → Resources/native/out
    path.join(process.resourcesPath, 'native', 'out', platformDir, fileName),
    // Dev dist-electron output: dist-electron/desktop/electron/ → ../../../native/out
    path.join(__dirname, '..', '..', '..', 'native', 'out', platformDir, fileName),
    // From compiled tsc layout: dist-electron/electron/ → ../../native/out
    path.join(__dirname, '..', '..', 'native', 'out', platformDir, fileName),
    // From source layout: electron/ → ../native/out
    path.join(__dirname, '..', 'native', 'out', platformDir, fileName),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      missingHelperUntil.delete(baseName)
      resolvedHelperPaths.set(baseName, candidate)
      return candidate
    }
  }

  // Remember the miss so poll-driven callers don't re-stat every tick.
  missingHelperUntil.set(baseName, Date.now() + NEGATIVE_CACHE_TTL_MS)
  return null
}
