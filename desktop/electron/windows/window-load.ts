import type { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { isLowMemoryWindowsDevice } from '../resource-profile.js'

export type WindowLoadMode = 'full' | 'mini' | 'overlay' | 'pet'

const getWindowEntryFile = (windowMode: WindowLoadMode) => {
  switch (windowMode) {
    case 'overlay':
      return 'overlay.html'
    case 'pet':
      return 'pet.html'
    case 'mini':
      return 'mini.html'
    case 'full':
    default:
      return 'index.html'
  }
}

const applyWindowQueryParams = (url: URL, windowMode: WindowLoadMode) => {
  url.searchParams.set('window', windowMode)
  if (isLowMemoryWindowsDevice()) {
    url.searchParams.set('lowPower', '1')
  }
}

export const getDevUrl = (windowMode: WindowLoadMode, getDevServerUrl: () => string) => {
  const url = new URL(getWindowEntryFile(windowMode), `${getDevServerUrl()}/`)
  applyWindowQueryParams(url, windowMode)
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
  window.loadFile(filePath, {
    query: {
      window: options.mode,
      ...(isLowMemoryWindowsDevice() ? { lowPower: '1' } : {}),
    },
  })
}
