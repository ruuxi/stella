import type { ElectronApi } from '@/shared/types/electron'

export const getElectronApi = (): ElectronApi | undefined => {
  return window.electronAPI
}

