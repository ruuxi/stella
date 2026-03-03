import type { BrowserWindow } from 'electron'
import path from 'path'

export type WindowLoadMode = 'full' | 'mini' | 'voice'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'mini':
      return 'mini.html'
    case 'full':
      return 'index.html'
    case 'voice':
      return 'index.html'
    default:
      return 'index.html'
  }
}

export const getDevUrl = (windowMode: WindowLoadMode, getDevServerUrl: () => string) => {
  const url = new URL(getWindowEntryFile(windowMode), `${getDevServerUrl()}/`)
  if (windowMode === 'voice') {
    url.searchParams.set('window', 'voice')
  }
  return url.toString()
}

const getFileTarget = (electronDir: string, windowMode: WindowLoadMode) => {
  const filePath = path.join(electronDir, `../dist/${getWindowEntryFile(windowMode)}`)
  if (windowMode === 'voice') {
    return { filePath, query: { window: 'voice' as const } }
  }
  return { filePath }
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
  if ('query' in target) {
    window.loadFile(target.filePath, { query: target.query })
    return
  }
  window.loadFile(target.filePath)
}
