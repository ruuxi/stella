import type { ElectronApi } from '../types/electron'

export const getElectronApi = (): ElectronApi | undefined => {
  if (typeof window === 'undefined') {
    return undefined
  }
  return window.electronAPI
}
