import { desktopCapturer } from 'electron'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

type DesktopSource = Awaited<ReturnType<typeof desktopCapturer.getSources>>[number]
type QueryWindowInfoOptions = {
  excludePids?: number[]
}

const DEFAULT_THUMB_SIZE = { width: 1280, height: 960 }

const getWindowInfoBin = () => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(__dirname, `../native/window_info${ext}`)
}

const queryWindowInfo = (x: number, y: number, options?: QueryWindowInfoOptions): Promise<WindowInfo | null> => {
  return new Promise((resolve) => {
    const args = [String(x), String(y)]
    if (options?.excludePids?.length) {
      args.push(`--exclude-pids=${options.excludePids.join(',')}`)
    }

    execFile(getWindowInfoBin(), args, { timeout: 3000 }, (error, stdout) => {
      if (error) {
        console.warn('window_info failed', error)
        resolve(null)
        return
      }
      try {
        const info = JSON.parse(stdout.trim())
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
 * Pre-fetch desktop capturer sources before showing any overlay windows.
 * Call this while the screen is still clean, then pass the result to captureWindowAtPoint.
 * Pass excludeSourceIds to filter out known windows (e.g. the mini shell).
 */
export const prefetchWindowSources = (excludeSourceIds?: string[]): Promise<DesktopSource[]> => {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: DEFAULT_THUMB_SIZE,
  }).then((sources) => {
    if (!excludeSourceIds?.length) return sources
    const excluded = new Set(excludeSourceIds)
    return sources.filter((s) => !excluded.has(s.id))
  })
}

export const captureWindowAtPoint = async (
  x: number,
  y: number,
  prefetchedSources?: DesktopSource[],
  options?: QueryWindowInfoOptions,
): Promise<WindowCapture | null> => {
  const info = await queryWindowInfo(x, y, options)
  if (!info || !info.title) return null

  const sources = prefetchedSources ?? await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: info.bounds.width, height: info.bounds.height },
  })

  // Match by title (best effort — desktopCapturer source names are window titles)
  const titleLower = info.title.toLowerCase()
  const match = sources.find((s) => s.name.toLowerCase() === titleLower)
    ?? sources.find((s) => titleLower.includes(s.name.toLowerCase()) || s.name.toLowerCase().includes(titleLower))

  if (!match) return null

  const image = match.thumbnail
  if (image.isEmpty()) return null

  const png = image.toPNG()
  const size = image.getSize()

  return {
    windowInfo: info,
    screenshot: {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: size.width,
      height: size.height,
    },
  }
}

/**
 * Capture a window screenshot using the native binary's --screenshot flag.
 * Returns window info + base64 PNG data URL, or null on failure.
 * This avoids desktopCapturer.getSources() entirely (~15ms vs 100-500ms).
 */
export const captureWindowScreenshot = async (
  x: number,
  y: number,
  options?: QueryWindowInfoOptions,
): Promise<WindowCapture | null> => {
  const tempPath = path.join(tmpdir(), `stella_cap_${randomBytes(8).toString('hex')}.png`)
  const args = [String(x), String(y), `--screenshot=${tempPath}`]
  if (options?.excludePids?.length) {
    args.push(`--exclude-pids=${options.excludePids.join(',')}`)
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(getWindowInfoBin(), args, { timeout: 5000 }, (error, out) => {
        if (error) return reject(error)
        resolve(out)
      })
    })

    const info = JSON.parse(stdout.trim()) as WindowInfo & { error?: string }
    if (info.error) return null

    let pngBuffer: Buffer
    try {
      pngBuffer = await fs.readFile(tempPath)
    } catch {
      // Screenshot file wasn't created (native capture failed), return info without screenshot
      return null
    }

    const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`

    return {
      windowInfo: info,
      screenshot: {
        dataUrl,
        width: info.bounds.width,
        height: info.bounds.height,
      },
    }
  } catch {
    return null
  } finally {
    // Clean up temp file
    fs.unlink(tempPath).catch(() => {})
  }
}
