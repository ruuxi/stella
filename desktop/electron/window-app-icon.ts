import { execFile } from 'child_process'
import { app } from 'electron'
import { listRecentApps } from './recent-apps.js'

/**
 * Resolves a small (32px) data-URL icon for the app owning a captured window,
 * keyed by app name and cached for the session. Used by the radial dial's Add
 * wedge to preview which app is about to be attached. Resolution is cheap:
 * macOS is one `ps` spawn + `app.getFileIcon` per unique app, Windows reuses
 * the daemon-backed recent-apps snapshot that already carries icons.
 */
const iconCache = new Map<string, Promise<string | null>>()

const getMacExecutablePath = (pid: number): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      'ps',
      ['-p', String(pid), '-o', 'comm='],
      { timeout: 2_000 },
      (error, stdout) => {
        resolve(error ? null : stdout.trim() || null)
      },
    )
  })

const resolveMacIcon = async (pid: number): Promise<string | null> => {
  const exePath = await getMacExecutablePath(pid)
  // Only .app bundles yield a real app icon; bare executables would resolve
  // to a generic file icon, which reads worse than the default Plus glyph.
  const bundlePath = exePath?.match(/^(.+?\.app)\//)?.[1]
  if (!bundlePath) return null

  const icon = await app.getFileIcon(bundlePath, { size: 'normal' })
  if (icon.isEmpty()) return null
  const dataUrl = icon.toDataURL()
  return dataUrl.startsWith('data:image/') ? dataUrl : null
}

const resolveWindowsIcon = async (
  pid: number,
  appName: string,
): Promise<string | null> => {
  const apps = await listRecentApps(12)
  if (!apps) return null
  const byPid = apps.find((entry) => entry.pid === pid)
  if (byPid?.iconDataUrl) return byPid.iconDataUrl
  const cleaned = appName.replace(/\.exe$/i, '').trim().toLowerCase()
  return (
    apps.find((entry) => entry.name.toLowerCase() === cleaned)?.iconDataUrl ??
    null
  )
}

export const getAppIconForWindow = (info: {
  pid: number
  process: string
}): Promise<string | null> => {
  const key = info.process.trim().toLowerCase()
  if (!key) return Promise.resolve(null)

  const cached = iconCache.get(key)
  if (cached) return cached

  const promise = (async () => {
    if (process.platform === 'darwin') return resolveMacIcon(info.pid)
    if (process.platform === 'win32')
      return resolveWindowsIcon(info.pid, info.process)
    return null
  })()
    .then((value) => {
      // Only successful lookups are cached for the session; misses (helper
      // cold, app gone) stay retryable on the next radial open.
      if (value === null) iconCache.delete(key)
      return value
    })
    .catch(() => {
      iconCache.delete(key)
      return null
    })

  iconCache.set(key, promise)
  return promise
}
