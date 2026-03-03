import type { WindowInfo } from './window-capture.js'

export type UiMode = 'chat' | 'voice'
export type WindowMode = 'full' | 'mini' | 'voice'

export type UiState = {
  mode: UiMode
  window: WindowMode
  view: 'chat' | 'store'
  conversationId: string | null
  isVoiceActive: boolean
  isVoiceRtcActive: boolean
}

export type ScreenshotCapture = {
  dataUrl: string
  width: number
  height: number
}

export type RegionSelection = {
  x: number
  y: number
  width: number
  height: number
}

export type RegionCaptureResult = {
  screenshot: ScreenshotCapture | null
  window: import('./chat-context.js').ChatContext['window']
}

export type CredentialRequestPayload = {
  requestId: string
  provider: string
  label?: string
  description?: string
  placeholder?: string
}

export type CredentialResponsePayload = {
  requestId: string
  secretId: string
  provider: string
  label: string
}

export const toChatContextWindow = (
  windowInfo: WindowInfo | null | undefined,
): import('./chat-context.js').ChatContext['window'] => {
  if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
    return null
  }
  return {
    title: windowInfo.title,
    app: windowInfo.process,
    bounds: windowInfo.bounds,
  }
}
