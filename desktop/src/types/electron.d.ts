import type { UiState, WindowMode } from './ui'

export type ElectronApi = {
  platform: string
  getUiState: () => Promise<UiState>
  setUiState: (partial: Partial<UiState>) => Promise<UiState>
  onUiState: (callback: (state: UiState) => void) => () => void
  showWindow: (target: WindowMode) => void
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
