import type { UiState, WindowMode } from './ui'

export type RadialWedge = 'ask' | 'chat' | 'voice' | 'full' | 'menu'

export type ElectronApi = {
  platform: string
  getUiState: () => Promise<UiState>
  setUiState: (partial: Partial<UiState>) => Promise<UiState>
  onUiState: (callback: (state: UiState) => void) => () => void
  showWindow: (target: WindowMode) => void
  captureScreenshot: () => Promise<{
    dataUrl: string
    width: number
    height: number
  } | null>
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
