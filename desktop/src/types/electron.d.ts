import type { UiState, WindowMode } from './ui'

export type RadialWedge = 'ask' | 'chat' | 'voice' | 'full' | 'menu'

export type ElectronApi = {
  platform: string
  
  // Window controls for custom title bar
  minimizeWindow: () => void
  maximizeWindow: () => void
  closeWindow: () => void
  isMaximized: () => Promise<boolean>
  
  getUiState: () => Promise<UiState>
  setUiState: (partial: Partial<UiState>) => Promise<UiState>
  onUiState: (callback: (state: UiState) => void) => () => void
  showWindow: (target: WindowMode) => void
  captureScreenshot: () => Promise<{
    dataUrl: string
    width: number
    height: number
  } | null>
  getDeviceId: () => Promise<string | null>
  configureHost: (config: { convexUrl?: string }) => Promise<{ deviceId: string | null }>
  setAuthToken: (payload: { token: string | null }) => Promise<{ ok: boolean }>
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void
  // App readiness gate (controls radial menu + mini shell)
  setAppReady: (ready: boolean) => void
  // Radial dial events
  onRadialShow: (callback: (event: unknown, data: { centerX: number; centerY: number }) => void) => () => void
  onRadialHide: (callback: () => void) => () => void
  onRadialCursor: (
    callback: (event: unknown, data: { x: number; y: number; centerX: number; centerY: number }) => void
  ) => () => void
  onRadialMouseUp: (callback: (event: unknown, data: { wedge: RadialWedge | null }) => void) => () => void
  radialSelect: (wedge: RadialWedge) => void
  // Theme sync across windows
  onThemeChange: (callback: (event: unknown, data: { key: string; value: string }) => void) => () => void
  broadcastThemeChange: (key: string, value: string) => void
  onCredentialRequest: (
    callback: (
      event: unknown,
      data: { requestId: string; provider: string; label?: string; description?: string; placeholder?: string }
    ) => void
  ) => () => void
  submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) => Promise<{ ok: boolean; error?: string }>
  cancelCredential: (payload: { requestId: string }) => Promise<{ ok: boolean; error?: string }>
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
