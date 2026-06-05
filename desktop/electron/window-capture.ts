import { nativeImage } from 'electron'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { runNativeHelper } from './native-helper.js'
import { requestWindowInfoDaemon } from './native-helper-daemon.js'
import { hasMacPermission } from './utils/macos-permissions.js'

export type WindowInfo = {
  title: string
  process: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
  axTree?: string | null
}

type WindowBounds = WindowInfo['bounds']

type WindowCapture = {
  windowInfo: WindowInfo
  screenshot: {
    dataUrl: string
    width: number
    height: number
  }
  axTree?: string | null
}

export type { WindowCapture }

type QueryWindowInfoOptions = {
  excludePids?: number[]
}

type MoveResizeWindowAtPointOptions = QueryWindowInfoOptions & {
  bounds: WindowBounds
}

type MoveResizeWindowAtPointResult = {
  windowInfo: WindowInfo
  moved: boolean
}

type WindowInfoByPidOptions = {
  excludePids?: number[]
}

const WINDOW_INFO_HELPER = 'window_info'

// Coalesce read-only "window at point" probes. The capture window-highlight
// preview and the morph-visibility fallback can fire many near-identical point
// queries in quick succession; on Windows each one is a `CreateProcess`, so a
// short TTL + in-flight dedup collapses a burst into a single spawn. The window
// under a screen point is stable over this window, so the staleness is benign.
const WINDOW_INFO_POINT_CACHE_MS = 200
type WindowInfoPointCacheEntry = { expiresAt: number; value: WindowInfo | null }
const windowInfoPointCache = new Map<string, WindowInfoPointCacheEntry>()
const windowInfoPointInFlight = new Map<string, Promise<WindowInfo | null>>()

const windowInfoPointKey = (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): string =>
  `${Math.round(x)},${Math.round(y)}|${(options?.excludePids ?? []).join(',')}`

const excludePidsArg = (options?: QueryWindowInfoOptions): string | null =>
  options?.excludePids?.length
    ? `--exclude-pids=${options.excludePids.join(',')}`
    : null

const parseWindowInfoJson = (stdout: string): WindowInfo | null => {
  try {
    const info = JSON.parse(stdout) as (WindowInfo & { error?: string }) | null
    if (!info || typeof info !== 'object' || info.error) return null
    return info
  } catch {
    return null
  }
}

const parseWindowInfoBatchJson = (
  stdout: string,
  expectedLength: number,
): (WindowInfo | null)[] | null => {
  try {
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed) || parsed.length !== expectedLength) return null
    return parsed.map((entry) =>
      !entry ||
      typeof entry !== 'object' ||
      (entry as { error?: unknown }).error
        ? null
        : (entry as WindowInfo),
    )
  } catch {
    return null
  }
}

/**
 * Resolve the topmost window at a point, preferring the persistent
 * `window_info --serve` daemon (a pipe write, no process spawn) and falling
 * back to a one-shot spawn when the daemon is unavailable. The daemon client
 * self-gates by platform, so callers don't branch on `process.platform`.
 */
const resolveWindowInfoAtPoint = async (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowInfo | null> => {
  const exclude = excludePidsArg(options)
  const tokens = exclude
    ? [String(x), String(y), exclude]
    : [String(x), String(y)]
  const daemonResponse = await requestWindowInfoDaemon(tokens)
  if (daemonResponse !== undefined) {
    return parseWindowInfoJson(daemonResponse)
  }
  return queryWindowInfo(x, y, options)
}

const queryWindowInfo = (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowInfo | null> => {
  return new Promise((resolve) => {
    const args = [String(x), String(y)]
    if (options?.excludePids?.length) {
      args.push(`--exclude-pids=${options.excludePids.join(',')}`)
    }

    void runNativeHelper(WINDOW_INFO_HELPER, args, {
      timeout: 3000,
      onError: (error) => {
        console.warn('window_info failed', error)
      },
    }).then((stdout) => {
      if (!stdout) {
        resolve(null)
        return
      }
      try {
        const info = JSON.parse(stdout)
        if (info.error) {
          resolve(null)
          return
        }
        resolve(info as WindowInfo)
      } catch {
        resolve(null)
      }
    })
  })
}

export const getWindowInfoAtPoint = (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowInfo | null> => {
  const key = windowInfoPointKey(x, y, options)
  const now = Date.now()
  const cached = windowInfoPointCache.get(key)
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value)
  }
  const inFlight = windowInfoPointInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const promise = resolveWindowInfoAtPoint(x, y, options)
  windowInfoPointInFlight.set(key, promise)
  return promise
    .then((value) => {
      windowInfoPointCache.set(key, {
        expiresAt: Date.now() + WINDOW_INFO_POINT_CACHE_MS,
        value,
      })
      return value
    })
    .finally(() => {
      windowInfoPointInFlight.delete(key)
    })
}

/**
 * Resolve the topmost window at each of several screen points in a single
 * native-helper invocation (`window_info --points=...`). Returns one entry
 * per input point (null where no window matched), or `null` when the helper
 * is unavailable / too old to support batch mode / returns an unexpected
 * shape — callers should fall back to per-point `getWindowInfoAtPoint` in
 * that case. Lets the morph-visibility gate probe its sample grid with one
 * process spawn instead of one per point (far cheaper on Windows, where each
 * spawn is a full CreateProcess).
 */
export const getWindowInfoBatchAtPoints = async (
  points: Array<{ x: number; y: number }>,
  options?: QueryWindowInfoOptions,
): Promise<(WindowInfo | null)[] | null> => {
  if (points.length === 0) return []
  const pointsArg = points
    .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
    .join(';')
  const tokens = [`--points=${pointsArg}`]
  const exclude = excludePidsArg(options)
  if (exclude) tokens.push(exclude)

  // Prefer the persistent daemon (one pipe write for all points). The client
  // self-gates by platform and returns undefined when it's unavailable.
  const daemonResponse = await requestWindowInfoDaemon(tokens)
  if (daemonResponse !== undefined) {
    const parsed = parseWindowInfoBatchJson(daemonResponse, points.length)
    if (parsed) return parsed
    // Daemon answered but the shape was unexpected — fall through to a
    // one-shot spawn rather than reporting a probe failure.
  }

  // Old binaries without batch support exit non-zero here; the caller falls
  // back to per-point queries, so this is expected, not logged.
  const stdout = await runNativeHelper(WINDOW_INFO_HELPER, tokens, {
    timeout: 3000,
    onError: () => {},
  })
  if (!stdout) return null
  return parseWindowInfoBatchJson(stdout, points.length)
}

export const moveResizeWindowAtPoint = (
  x: number,
  y: number,
  options: MoveResizeWindowAtPointOptions,
): Promise<MoveResizeWindowAtPointResult | null> => {
  return new Promise((resolve) => {
    const args = [String(x), String(y)]
    if (options.excludePids?.length) {
      args.push(`--exclude-pids=${options.excludePids.join(',')}`)
    }
    const { bounds } = options
    args.push(
      `--set-bounds=${[bounds.x, bounds.y, bounds.width, bounds.height]
        .map((value) => Math.round(value))
        .join(',')}`,
    )

    void runNativeHelper(WINDOW_INFO_HELPER, args, {
      timeout: 3000,
      onError: (error) => {
        console.warn('window_info move failed', error)
      },
    }).then((stdout) => {
      if (!stdout) {
        resolve(null)
        return
      }
      try {
        const info = JSON.parse(stdout) as WindowInfo & {
          error?: string
          moved?: boolean
        }
        if (info.error) {
          resolve(null)
          return
        }
        resolve({
          windowInfo: info,
          moved: info.moved === true,
        })
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * Capture a window screenshot using the native binary's --screenshot flag.
 * Returns window info + base64 PNG data URL, or null on failure.
 * Uses PrintWindow (Windows) / CGWindowListCreateImage (macOS) to capture
 * a single window directly — no desktopCapturer enumeration needed (~15ms vs 100-500ms).
 */
export const captureWindowScreenshot = async (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowCapture | null> => {
  if (!hasMacPermission('screen')) return null

  const tempPath = path.join(
    tmpdir(),
    `stella_cap_${randomBytes(8).toString('hex')}.png`,
  )
  const args = [String(x), String(y), `--screenshot=${tempPath}`]
  if (options?.excludePids?.length) {
    args.push(`--exclude-pids=${options.excludePids.join(',')}`)
  }

  return runWindowCapture(WINDOW_INFO_HELPER, args, tempPath)
}

const HOME_CAPTURE_HELPER = 'home_capture'

/**
 * Capture the topmost window owned by `pid`. Used by the home suggestion
 * chip lazy-capture path: the chip attaches eagerly with metadata and we
 * patch in the screenshot when this resolves.
 *
 * Backed by the dedicated `home_capture` helper (separate from
 * `desktop_automation` / `window_info`) because the home flow needs
 * different defaults: include off-Space windows in the search, skip the
 * point-based layer-0 filter, and use ScreenCaptureKit with
 * `onScreenWindowsOnly: false` so off-Space windows still capture.
 */
export const captureWindowScreenshotByPid = async (
  pid: number,
  _options?: WindowInfoByPidOptions,
): Promise<WindowCapture | null> => {
  if (!hasMacPermission('screen')) return null
  if (!Number.isFinite(pid) || pid <= 0) return null

  const tempPath = path.join(
    tmpdir(),
    `stella_cap_${randomBytes(8).toString('hex')}.png`,
  )
  const args = [`--pid=${pid}`, `--screenshot=${tempPath}`]

  return runWindowCapture(HOME_CAPTURE_HELPER, args, tempPath)
}

const runWindowCapture = async (
  helperName: string,
  args: string[],
  tempPath: string,
): Promise<WindowCapture | null> => {
  try {
    const stdout = await runNativeHelper(helperName, args, { timeout: 5000 })
    if (!stdout) return null

    const info = JSON.parse(stdout) as WindowInfo & { error?: string }
    if (info.error) return null

    let pngBuffer: Buffer
    try {
      pngBuffer = await fs.readFile(tempPath)
    } catch {
      // Screenshot file wasn't created (native capture failed); return null
      return null
    }

    const image = nativeImage.createFromBuffer(pngBuffer)
    const size = image.getSize()
    const dataUrl = image.toDataURL()

    return {
      windowInfo: info,
      screenshot: { dataUrl, width: size.width, height: size.height },
      axTree:
        typeof info.axTree === 'string' && info.axTree.trim()
          ? info.axTree
          : null,
    }
  } catch {
    return null
  } finally {
    fs.unlink(tempPath).catch(() => {})
  }
}
