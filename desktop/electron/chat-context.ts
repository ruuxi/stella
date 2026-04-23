import { getSelectedText } from './selected-text.js'
import { getWindowInfoAtPoint } from './window-capture.js'
import { captureWindowContent } from './window-content-capture.js'
import type { ChatContext } from '../src/shared/contracts/boundary.js'

type CaptureChatContextOptions = {
  excludeCurrentProcessWindows?: boolean
}

export const captureChatContext = async (
  point: { x: number; y: number },
  options?: CaptureChatContextOptions,
): Promise<ChatContext> => {
  const excludePids = options?.excludeCurrentProcessWindows ? [process.pid] : undefined

  const [selectedTextResult, windowInfo] = await Promise.all([
    getSelectedText(),
    getWindowInfoAtPoint(point.x, point.y, { excludePids }),
  ])
  const selectedText = selectedTextResult?.text ?? null

  let windowScreenshot: ChatContext['windowScreenshot'] = null
  let capturedWindowInfo = windowInfo
  if (windowInfo) {
    const capture = await captureWindowContent(point.x, point.y, { excludePids, windowInfo })
    if (capture) {
      capturedWindowInfo = capture.windowInfo
      windowScreenshot = capture.screenshot
    }
  }

  const window = capturedWindowInfo && (capturedWindowInfo.title || capturedWindowInfo.process)
    ? {
        title: capturedWindowInfo.title,
        app: capturedWindowInfo.process,
        bounds: capturedWindowInfo.bounds,
      }
    : null

  return {
    window,
    browserUrl: null,
    selectedText,
    regionScreenshots: [],
    windowScreenshot,
  }
}
