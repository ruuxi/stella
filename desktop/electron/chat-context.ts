import { getSelectedText } from './selected-text.js'

export type WindowBounds = { x: number; y: number; width: number; height: number }

export type ChatContext = {
  window: {
    title: string
    app: string
    bounds: WindowBounds
  } | null
  browserUrl?: string | null
  selectedText?: string | null
  regionScreenshot?: {
    dataUrl: string
    width: number
    height: number
  } | null
}

export const captureChatContext = async (_point: { x: number; y: number }): Promise<ChatContext> => {
  // Get selected text via platform-native API (UI Automation on Windows, Accessibility on macOS)
  const selectedText = await getSelectedText()

  return {
    window: null,
    browserUrl: null,
    selectedText,
    regionScreenshot: null,
  }
}
