import type { UiState, UiStateUpdate, WindowMode } from './ui'
import type {
  ScreenInvokeRequest,
  ScreenInvokeResult,
  ScreenListRequest,
  ScreenListResult,
} from '../screens/host/screen-types'

export type RadialWedge = 'ask' | 'chat' | 'voice' | 'full' | 'menu'

export type ElectronApi = {
  platform: string
  getUiState: () => Promise<UiState>
  setUiState: (partial: UiStateUpdate) => Promise<UiState>
  onUiState: (callback: (state: UiState) => void) => () => void
  showWindow: (target: WindowMode) => void
  captureScreenshot: () => Promise<{
    dataUrl: string
    width: number
    height: number
  } | null>
  getDeviceId: () => Promise<string | null>
  configureHost: (config: { convexUrl?: string }) => Promise<{ deviceId: string | null }>
  onScreenInvoke: (callback: (request: ScreenInvokeRequest) => void) => () => void
  respondScreenInvoke: (result: ScreenInvokeResult) => void
  onScreenListRequest: (callback: (request: ScreenListRequest) => void) => (() => void) | void
  respondScreenList: (result: ScreenListResult) => void
  // Radial dial events
  onRadialShow: (callback: (event: unknown, data: { centerX: number; centerY: number }) => void) => () => void
  onRadialHide: (callback: () => void) => () => void
  onRadialCursor: (
    callback: (event: unknown, data: { x: number; y: number; centerX: number; centerY: number }) => void
  ) => () => void
  onRadialMouseUp: (callback: (event: unknown, data: { wedge: RadialWedge | null }) => void) => () => void
  radialSelect: (wedge: RadialWedge) => void
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
