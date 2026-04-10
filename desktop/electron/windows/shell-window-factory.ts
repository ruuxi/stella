import { BrowserWindow, type RenderProcessGoneDetails } from 'electron'
import path from 'path'
import { loadWindow, type WindowLoadMode } from './window-load.js'

type ShellWindowMode = Extract<WindowLoadMode, 'full' | 'mini'>

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

export const loadShellRecoveryPage = (
  window: BrowserWindow | null,
  electronDir: string,
) => {
  if (!window || window.isDestroyed()) {
    return
  }

  window.loadFile(path.join(electronDir, 'recovery.html'))
}
