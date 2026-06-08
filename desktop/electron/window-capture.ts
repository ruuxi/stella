import { nativeImage } from 'electron'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { runNativeHelper } from './native-helper.js'
import { requestWindowInfoDaemon } from './native-helper-daemon.js'
import { hasMacPermission } from './utils/macos-permissions.js'
import type { ScreenshotCapture } from './types.js'

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
  excludeTitlePrefixes?: string[]
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
export const STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES = ['Stella Overlay']

// Coalesce read-only "window at point" probes. The capture window-highlight
// preview and the morph-visibility fallback can fire many near-identical point
// queries in quick succession; on Windows each one is a `CreateProcess`, so a
// short TTL + in-flight dedup collapses a burst into a single spawn. The window
// under a screen point is stable over this window, so the staleness is benign.
const WINDOW_INFO_POINT_CACHE_MS = 200
// Cap the dedupe cache: it's keyed per cursor pixel, so without a bound it
// grows one entry per unique coordinate forever. The entry only backs a 200ms
// dedupe window, so a tiny cap is plenty; we evict oldest-inserted on overflow
// (Map preserves insertion order) so the live 200ms set is always retained.
const WINDOW_INFO_POINT_CACHE_MAX = 256
type WindowInfoPointCacheEntry = { expiresAt: number; value: WindowInfo | null }
const windowInfoPointCache = new Map<string, WindowInfoPointCacheEntry>()
const windowInfoPointInFlight = new Map<string, Promise<WindowInfo | null>>()

const windowInfoPointKey = (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): string =>
  `${Math.round(x)},${Math.round(y)}|${(options?.excludePids ?? []).join(',')}|${(options?.excludeTitlePrefixes ?? []).join(',')}`

const excludePidsArg = (options?: QueryWindowInfoOptions): string | null =>
  options?.excludePids?.length
    ? `--exclude-pids=${options.excludePids.join(',')}`
    : null

const excludeTitlePrefixesArg = (
  options?: QueryWindowInfoOptions,
): string | null =>
  options?.excludeTitlePrefixes?.length
    ? `--exclude-title-prefixes=${options.excludeTitlePrefixes.join(',')}`
    : null

const exclusionArgs = (options?: QueryWindowInfoOptions): string[] =>
  [excludePidsArg(options), excludeTitlePrefixesArg(options)].filter(
    (arg): arg is string => Boolean(arg),
  )

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
  const tokens = [String(x), String(y), ...exclusionArgs(options)]
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
    args.push(...exclusionArgs(options))

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
  // Evict on expiry rather than leaving the stale entry in the Map; otherwise
  // a coordinate visited once keeps its entry forever even though the 200ms
  // dedupe window is long gone.
  if (cached) windowInfoPointCache.delete(key)
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
      // Bound total size: drop the oldest-inserted key (which is also the
      // closest to expiry) so the cache can't grow without limit across a
      // long session of cursor movement.
      if (windowInfoPointCache.size > WINDOW_INFO_POINT_CACHE_MAX) {
        const oldest = windowInfoPointCache.keys().next().value
        if (oldest !== undefined) windowInfoPointCache.delete(oldest)
      }
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
  tokens.push(...exclusionArgs(options))

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
    args.push(...exclusionArgs(options))
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

type NativeShotJson = {
  title?: string
  process?: string
  pid?: number
  bounds?: WindowBounds
  image?: string
  imageWidth?: number
  imageHeight?: number
  error?: string
}

const safeParseJson = (raw: string): NativeShotJson | null => {
  try {
    const parsed = JSON.parse(raw) as NativeShotJson
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const shotTokens = (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): string[] => {
  const tokens = ['--shot', String(x), String(y)]
  tokens.push(...exclusionArgs(options))
  return tokens
}

const buildWindowCaptureFromShot = (
  data: NativeShotJson | null,
): WindowCapture | null => {
  if (!data || data.error || !data.image || !data.bounds) return null
  return {
    windowInfo: {
      title: typeof data.title === 'string' ? data.title : '',
      process: typeof data.process === 'string' ? data.process : '',
      pid: typeof data.pid === 'number' ? data.pid : 0,
      bounds: data.bounds,
      axTree: null,
    },
    screenshot: {
      dataUrl: data.image,
      width:
        typeof data.imageWidth === 'number'
          ? data.imageWidth
          : data.bounds.width,
      height:
        typeof data.imageHeight === 'number'
          ? data.imageHeight
          : data.bounds.height,
    },
    axTree: null,
  }
}

/**
 * Windows window capture: ask the warm `--serve` daemon for a base64 JPEG of
 * the window at the point (one pipe write, no spawn, no temp file, no PNG
 * double-encode), falling back to a one-shot `--shot` spawn when the daemon is
 * unavailable. Both emit the same JSON shape.
 */
const captureWindowScreenshotWin32 = async (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowCapture | null> => {
  const tokens = shotTokens(x, y, options)

  const daemonResponse = await requestWindowInfoDaemon(tokens)
  if (daemonResponse !== undefined) {
    const built = buildWindowCaptureFromShot(safeParseJson(daemonResponse))
    if (built) return built
  }

  const stdout = await runNativeHelper(WINDOW_INFO_HELPER, tokens, {
    timeout: 5000,
    onError: () => {},
  })
  if (!stdout) return null
  return buildWindowCaptureFromShot(safeParseJson(stdout))
}

/**
 * Capture a window screenshot. On Windows this uses the daemon/base64 fast
 * path (no temp file, JPEG); on macOS it uses the Swift helper's
 * `--screenshot=path` flag. Returns window info + image data URL, or null.
 * Captures a single window directly via PrintWindow (Windows) /
 * ScreenCaptureKit (macOS) — no desktopCapturer enumeration (~15ms vs 100-500ms).
 */
export const captureWindowScreenshot = async (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowCapture | null> => {
  if (!hasMacPermission('screen')) return null

  if (process.platform === 'win32') {
    return captureWindowScreenshotWin32(x, y, options)
  }

  const tempPath = path.join(
    tmpdir(),
    `stella_cap_${randomBytes(8).toString('hex')}.png`,
  )
  const args = [String(x), String(y), `--screenshot=${tempPath}`]
  args.push(...exclusionArgs(options))

  return runWindowCapture(WINDOW_INFO_HELPER, args, tempPath)
}

/**
 * Windows-only native region capture: BitBlt a virtual-screen rectangle
 * (physical pixels) straight from the screen DC via the native helper,
 * returning a base64 JPEG. Far cheaper than capturing every display at full
 * resolution and cropping (Electron's desktopCapturer). Tries the warm daemon
 * first, then a one-shot spawn; returns null on any failure so the caller can
 * fall back to desktopCapturer. No-op (null) off Windows.
 */
export const captureRegionScreenshotNative = async (
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<ScreenshotCapture | null> => {
  if (process.platform !== 'win32') return null
  if (width <= 0 || height <= 0) return null

  const regionArg = `--region=${Math.round(x)},${Math.round(y)},${Math.round(
    width,
  )},${Math.round(height)}`

  const daemonResponse = await requestWindowInfoDaemon([regionArg])
  let data = daemonResponse !== undefined ? safeParseJson(daemonResponse) : null

  if (!data || !data.image) {
    const stdout = await runNativeHelper(WINDOW_INFO_HELPER, [regionArg], {
      timeout: 5000,
      onError: () => {},
    })
    data = stdout ? safeParseJson(stdout) : null
  }

  if (!data || data.error || !data.image) return null
  return {
    dataUrl: data.image,
    width:
      typeof data.imageWidth === 'number'
        ? data.imageWidth
        : Math.round(width),
    height:
      typeof data.imageHeight === 'number'
        ? data.imageHeight
        : Math.round(height),
  }
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
