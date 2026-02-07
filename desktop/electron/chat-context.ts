import { getSelectedText } from './selected-text.js'
import { getWindowInfoAtPoint } from './window-capture.js'

export type WindowBounds = { x: number; y: number; width: number; height: number }

export type ChatContext = {
  window: {
    title: string
    app: string
    bounds: WindowBounds
  } | null
  browserUrl?: string | null
  selectedText?: string | null
  regionScreenshots?: {
    dataUrl: string
    width: number
    height: number
  }[]
  capturePending?: boolean
}

export const captureChatContext = async (point: { x: number; y: number }): Promise<ChatContext> => {
  // Capture selected text and window metadata in parallel.
  const [selectedText, windowInfo] = await Promise.all([
    getSelectedText(),
    getWindowInfoAtPoint(point.x, point.y),
  ])

  const window = windowInfo && (windowInfo.title || windowInfo.process)
    ? {
        title: windowInfo.title,
        app: windowInfo.process,
        bounds: windowInfo.bounds,
      }
    : null

  return {
    window,
    browserUrl: null,
    selectedText,
    regionScreenshots: [],
  }
}
