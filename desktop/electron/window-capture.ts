import { nativeImage } from 'electron'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { runNativeHelper } from './native-helper.js'
import { hasMacPermission } from './utils/macos-permissions.js'

export type WindowInfo = {
  title: string
  process: string
  pid: number
  bounds: { x: number; y: number; width: number; height: number }
}

type WindowCapture = {
  windowInfo: WindowInfo
  screenshot: {
    dataUrl: string
    width: number
    height: number
  }
}

export type { WindowCapture }

type QueryWindowInfoOptions = {
  excludePids?: number[]
}

type WindowInfoByPidOptions = {
  excludePids?: number[]
}

const WINDOW_INFO_HELPER = 'window_info'

const queryWindowInfo = (x: number, y: number, options?: QueryWindowInfoOptions): Promise<WindowInfo | null> => {
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
  return queryWindowInfo(x, y, options)
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

  const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`)
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

  const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`)
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
    }
  } catch {
    return null
  } finally {
    fs.unlink(tempPath).catch(() => {})
  }
}
