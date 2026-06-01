import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
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
// resolutions are cached, so a helper that is downloaded mid-session (e.g.
// via `native:download`) is still picked up on a later call.
const resolvedHelperPaths = new Map<string, string>()

export const resolveNativeHelperPath = (baseName: string): string | null => {
  const cached = resolvedHelperPaths.get(baseName)
  if (cached !== undefined) {
    return cached
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
      resolvedHelperPaths.set(baseName, candidate)
      return candidate
    }
  }

  return null
}
