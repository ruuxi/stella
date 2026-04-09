import { nativeImage } from 'electron'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import {
  captureWindowScreenshot,
  getWindowInfoAtPoint,
  type WindowCapture,
  type WindowInfo,
} from './window-capture.js'
import { runNativeHelper } from './native-helper.js'
import { hasMacPermission } from './utils/macos-permissions.js'

const MAX_IMAGE_DIM = 1200
const MIN_CROP_SIZE = 40
const LAYOUT_DETECT_TIMEOUT_MS = 3000

type ContentBounds = {
  x: number
  y: number
  width: number
  height: number
}

type WindowContentCapture = {
  dataUrl: string
  width: number
  height: number
}

export async function captureWindowContent(
  x: number,
  y: number,
  options?: { excludePids?: number[]; windowInfo?: WindowInfo | null },
): Promise<{
  windowInfo: WindowInfo
  screenshot: WindowContentCapture
} | null> {
  if (!hasMacPermission('accessibility') || !hasMacPermission('screen')) return null

  const windowInfo =
    options?.windowInfo
    ?? await getWindowInfoAtPoint(x, y, { excludePids: options?.excludePids })
  if (!windowInfo) return null

  const windowCapture = await captureWindowScreenshot(x, y, {
    excludePids: options?.excludePids,
  })
  if (!windowCapture) return null

  const effectiveWindowInfo = windowCapture.windowInfo

  // Use Vision framework layout detection for content-area cropping
  const contentBounds = await detectContentColumn(
    windowCapture,
    { cursorX: x, cursorY: y },
  )

  const screenshot = cropWindowCapture(
    windowCapture,
    contentBounds,
  )
  if (!screenshot) return null

  return {
    windowInfo: effectiveWindowInfo,
    screenshot,
  }
}

/**
 * Detect the content column at the cursor position using Vision framework.
 * Writes the window screenshot to a temp file, runs the native layout detector
 * which finds text block positions and uses band detection to identify the
 * column the cursor is in. Returns crop bounds or null (= use full window).
 */
async function detectContentColumn(
  windowCapture: WindowCapture,
  cursor: { cursorX: number; cursorY: number },
): Promise<ContentBounds | null> {
  const { bounds } = windowCapture.windowInfo
  if (bounds.width <= 0 || bounds.height <= 0) return null

  // Compute normalized cursor position relative to window
  const normX = Math.max(0, Math.min(1, (cursor.cursorX - bounds.x) / bounds.width))
  const normY = Math.max(0, Math.min(1, (cursor.cursorY - bounds.y) / bounds.height))

  // Write screenshot to temp file for the native helper
  const tempPath = path.join(tmpdir(), `stella_layout_${randomBytes(8).toString('hex')}.png`)
  try {
    const base64Data = windowCapture.screenshot.dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await fs.writeFile(tempPath, Buffer.from(base64Data, 'base64'))

    const stdout = await runNativeHelper('window_ocr', [
      tempPath,
      String(normX),
      String(normY),
    ], {
      timeout: LAYOUT_DETECT_TIMEOUT_MS,
    })

    if (!stdout) return null

    const crop = JSON.parse(stdout) as { x: number; y: number; width: number; height: number }
    if (crop.width <= 0 || crop.height <= 0) return null

    // Convert normalized crop bounds back to screen coordinates
    return {
      x: bounds.x + crop.x * bounds.width,
      y: bounds.y + crop.y * bounds.height,
      width: crop.width * bounds.width,
      height: crop.height * bounds.height,
    }
  } catch {
    return null
  } finally {
    fs.unlink(tempPath).catch(() => {})
  }
}

function cropWindowCapture(
  windowCapture: WindowCapture,
  contentBounds: ContentBounds | null,
): WindowContentCapture | null {
  let image = nativeImage.createFromDataURL(windowCapture.screenshot.dataUrl)
  const imageSize = image.getSize()
  const windowBounds = windowCapture.windowInfo.bounds
  const targetBounds = contentBounds ?? windowBounds

  const relativeX = Math.max(0, targetBounds.x - windowBounds.x)
  const relativeY = Math.max(0, targetBounds.y - windowBounds.y)
  const availableWidth = Math.max(0, windowBounds.width - relativeX)
  const availableHeight = Math.max(0, windowBounds.height - relativeY)

  const scaleX = windowBounds.width > 0 ? imageSize.width / windowBounds.width : 1
  const scaleY = windowBounds.height > 0 ? imageSize.height / windowBounds.height : 1

  const cropX = Math.max(0, Math.round(relativeX * scaleX))
  const cropY = Math.max(0, Math.round(relativeY * scaleY))
  const cropWidth = Math.min(
    imageSize.width - cropX,
    Math.round(Math.min(targetBounds.width, availableWidth) * scaleX),
  )
  const cropHeight = Math.min(
    imageSize.height - cropY,
    Math.round(Math.min(targetBounds.height, availableHeight) * scaleY),
  )

  if (cropWidth >= MIN_CROP_SIZE && cropHeight >= MIN_CROP_SIZE) {
    image = image.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight })
  }

  const croppedSize = image.getSize()
  if (croppedSize.width <= 0 || croppedSize.height <= 0) {
    return null
  }

  if (croppedSize.width > MAX_IMAGE_DIM || croppedSize.height > MAX_IMAGE_DIM) {
    const ratio = Math.min(MAX_IMAGE_DIM / croppedSize.width, MAX_IMAGE_DIM / croppedSize.height)
    image = image.resize({
      width: Math.max(1, Math.round(croppedSize.width * ratio)),
      height: Math.max(1, Math.round(croppedSize.height * ratio)),
      quality: 'good',
    })
  }

  const finalSize = image.getSize()
  return {
    dataUrl: image.toDataURL(),
    width: finalSize.width,
    height: finalSize.height,
  }
}
