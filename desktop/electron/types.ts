import type { WindowInfo } from './window-capture.js'
import type { ChatContext } from '../../runtime/contracts/index.js'
import type {
  UiMode,
  WindowMode,
  UiState,
} from '../src/shared/contracts/ui.js'

export type { UiMode, WindowMode, UiState }

export type ScreenshotCapture = {
  dataUrl: string
  width: number
  height: number
}

export type VisionCoordinateSpace = {
  x: number
  y: number
  logicalWidth: number
  logicalHeight: number
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
}

export type VisionScreenshotCapture = ScreenshotCapture & {
  coordinateSpace: VisionCoordinateSpace
}

export type VisionDisplayCapture = VisionScreenshotCapture & {
  displayId: number
  screenNumber: number
  label: string
  isPrimaryFocus: boolean
}

export type RegionSelection = {
  x: number
  y: number
  width: number
  height: number
}

export type RegionCaptureResult = {
  screenshot: ScreenshotCapture | null
  window: ChatContext['window']
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
): ChatContext['window'] => {
  if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
    return null
  }
  return {
    title: windowInfo.title,
    app: windowInfo.process,
    bounds: windowInfo.bounds,
  }
}
