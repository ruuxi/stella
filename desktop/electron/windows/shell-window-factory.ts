import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import fs from 'fs'
import path from 'path'
import { loadWindow, type WindowLoadMode } from './window-load.js'

export type ShellWindowMode = Extract<WindowLoadMode, 'full' | 'mini'>

export type ShellWindowDidFailLoadDetails = {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

type ShellWindowFactoryOptions = {
  mode: ShellWindowMode
  electronDir: string
  isDev: boolean
  getDevServerUrl: () => string
  createWindow: () => BrowserWindow
  setupExternalLinkHandlers: (window: BrowserWindow) => void
  onDidStartLoading?: () => void
  onRenderProcessGone?: (details: RenderProcessGoneDetails, window: BrowserWindow) => void
  onDidFailLoad?: (
    details: ShellWindowDidFailLoadDetails,
    window: BrowserWindow,
  ) => void
  onClosed?: (window: BrowserWindow) => void
}

type ShellWindowLoadOptions = Pick<
  ShellWindowFactoryOptions,
  'electronDir' | 'isDev' | 'mode' | 'getDevServerUrl'
>

const shouldOpenDevTools = process.env.STELLA_OPEN_DEVTOOLS === '1'

const loadShellMainWindow = (
  window: BrowserWindow,
  options: ShellWindowLoadOptions,
) => {
  loadWindow(window, {
    electronDir: options.electronDir,
    isDev: options.isDev,
    mode: options.mode,
    getDevServerUrl: options.getDevServerUrl,
  })
}

export const createShellWindow = (options: ShellWindowFactoryOptions) => {
  const window = options.createWindow()

  options.setupExternalLinkHandlers(window)

  if (options.isDev && shouldOpenDevTools) {
    window.webContents.openDevTools()
  }

  window.webContents.on('did-start-loading', () => {
    options.onDidStartLoading?.()
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    options.onRenderProcessGone?.(details, window)
  })

  window.webContents.on(
    'did-fail-load',
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
    ) => {
      options.onDidFailLoad?.(
        {
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
        },
        window,
      )
    },
  )

  window.on('closed', () => {
    options.onClosed?.(window)
  })

  loadShellMainWindow(window, options)

  return window
}

export const reloadShellMainWindow = (
  window: BrowserWindow | null,
  options: ShellWindowLoadOptions,
) => {
  if (!window || window.isDestroyed()) {
    return
  }

  loadShellMainWindow(window, options)
}

/**
 * Resolves a readable path to `recovery.html` from the running main process.
 *
 * `tsc` does not copy static assets into `dist-electron/`, so the historical
 * `loadFile(path.join(electronDir, 'recovery.html'))` always pointed at a
 * non-existent file. We instead resolve from the source tree at runtime:
 *
 *   - In dev, `electronDir` is `desktop/dist-electron/desktop/electron`, so
 *     `../../../electron/recovery.html` walks back to the source file.
 *   - In packaged builds, `electron-builder` ships the entire `desktop/`
 *     source tree (the `files` glob is `dist-electron/**`, but ASAR resolves
 *     relative paths within the bundle and we register the source layout via
 *     `extraFiles` below). We probe both the compiled-adjacent path and the
 *     dev fallback so packaging changes can't silently re-break recovery.
 */
const resolveRecoveryHtmlPath = (electronDir: string): string | null => {
  const candidates = [
    path.join(electronDir, 'recovery.html'),
    path.resolve(electronDir, '../../../electron/recovery.html'),
    path.resolve(electronDir, '../../../../electron/recovery.html'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Loads the recovery surface into a window. Reads `recovery.html` from disk
 * and serves it via a `data:` URL so we never have to do a `file://`
 * navigation from an `http://` (dev) origin — Chromium blocks that as
 * "Not allowed to load local resource", which used to leave the window blank.
 */
export const loadShellRecoveryPage = (
  window: BrowserWindow | null,
  electronDir: string,
) => {
  if (!window || window.isDestroyed()) {
    return
  }

  const recoveryPath = resolveRecoveryHtmlPath(electronDir)
  if (!recoveryPath) {
    console.error(
      '[recovery] Could not locate recovery.html relative to',
      electronDir,
    )
    return
  }

  try {
    const html = fs.readFileSync(recoveryPath, 'utf-8')
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`
    void window.loadURL(dataUrl)
  } catch (error) {
    console.error('[recovery] Failed to load recovery surface:', error)
  }
}
