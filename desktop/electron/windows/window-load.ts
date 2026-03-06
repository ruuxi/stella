import type { BrowserWindow } from 'electron'
import path from 'path'

export type WindowLoadMode = 'full' | 'overlay' | 'voice-runtime'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'voice-runtime':
      return 'voice-runtime.html'
    case 'full':
    default:
      return 'index.html'
  }
}

export const getDevUrl = (windowMode: WindowLoadMode, getDevServerUrl: () => string) => {
  return new URL(getWindowEntryFile(windowMode), `${getDevServerUrl()}/`).toString()
}

const getFileTarget = (electronDir: string, windowMode: WindowLoadMode) => {
  return { filePath: path.join(electronDir, `../dist/${getWindowEntryFile(windowMode)}`) }
}

export const loadWindow = (
  window: BrowserWindow,
  options: {
    electronDir: string
    isDev: boolean
    mode: WindowLoadMode
    getDevServerUrl: () => string
  },
) => {
  if (options.isDev) {
    window.loadURL(getDevUrl(options.mode, options.getDevServerUrl))
    return
  }

  const target = getFileTarget(options.electronDir, options.mode)
  window.loadFile(target.filePath)
}
