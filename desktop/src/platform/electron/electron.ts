import type { ElectronApi } from '@/types/electron'

export const getElectronApi = (): ElectronApi | undefined => {
  return window.electronAPI
}

