import type { BrowserWindow, LoadFileOptions } from 'electron'
import fs from 'fs'
import path from 'path'

export type WindowLoadMode = 'full' | 'mini' | 'overlay' | 'pet'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'pet':
      return 'pet.html'
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

  const entryFile = getWindowEntryFile(options.mode)
  const candidates = [
    path.resolve(options.electronDir, '../../../dist', entryFile),
    path.resolve(options.electronDir, '../dist', entryFile),
  ]
  const filePath =
    candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    }) ?? candidates[0]
  const query = getWindowQuery(options.mode)
  if (query) {
    window.loadFile(filePath, { query })
    return
  }
  window.loadFile(filePath)
}
