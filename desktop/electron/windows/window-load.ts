import type { BrowserWindow, LoadFileOptions } from 'electron'
import path from 'path'

export type WindowLoadMode = 'full' | 'mini' | 'overlay'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'mini':
    case 'full':
    default:
      return 'index.html'
  }
}

const getWindowQuery = (
  windowMode: WindowLoadMode,
): LoadFileOptions['query'] | undefined => {
  if (windowMode === 'mini') {
    return { window: 'mini' }
  }
  return undefined
}

export const getDevUrl = (windowMode: WindowLoadMode, getDevServerUrl: () => string) => {
  const url = new URL(getWindowEntryFile(windowMode), `${getDevServerUrl()}/`)
  const query = getWindowQuery(windowMode)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
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
  const query = getWindowQuery(options.mode)
  if (query) {
    window.loadFile(target.filePath, { query })
    return
  }
  window.loadFile(target.filePath)
}
