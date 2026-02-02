import { app, BrowserWindow, desktopCapturer, ipcMain, screen, type Display } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { MouseHookManager } from './mouse-hook.js'
import {
  createRadialWindow,
  showRadialWindow,
  hideRadialWindow,
  updateRadialCursor,
  getRadialWindow,
  calculateSelectedWedge,
  type RadialWedge,
} from './radial-window.js'
import { showRegionCaptureWindow, hideRegionCaptureWindow } from './region-capture-window.js'
import { captureChatContext, type ChatContext } from './chat-context.js'
import { initSelectedTextProcess, cleanupSelectedTextProcess } from './selected-text.js'
import {
  createModifierOverlay,
  showModifierOverlay,
  hideModifierOverlay,
  destroyModifierOverlay,
} from './modifier-overlay.js'
import { getOrCreateDeviceId } from './local-host/device.js'
import { createLocalHostRunner } from './local-host/runner.js'
import { resolveStellarHome } from './local-host/stellar-home.js'
import {
  collectBrowserData,
  coreMemoryExists,
  writeCoreMemory,
  formatBrowserDataForSynthesis,
  type BrowserData,
} from './local-host/browser-data.js'
import { collectAllSignals } from './local-host/collect-all.js'
import type { AllUserSignalsResult } from './local-host/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type UiMode = 'chat' | 'voice'
type WindowMode = 'full' | 'mini'

type UiState = {
  mode: UiMode
  window: WindowMode
  conversationId: string | null
}

type ScreenshotCapture = {
  dataUrl: string
  width: number
  height: number
}

type RegionSelection = {
  x: number
  y: number
  width: number
  height: number
}

type CredentialRequestPayload = {
  requestId: string
  provider: string
  label?: string
  description?: string
  placeholder?: string
}

type CredentialResponsePayload = {
  requestId: string
  secretId: string
  provider: string
  label: string
}

const isDev = process.env.NODE_ENV === 'development'
const AUTH_PROTOCOL = 'stellar'

const getDeepLinkUrl = (argv: string[]) =>
  argv.find((arg) => arg.startsWith(`${AUTH_PROTOCOL}://`)) || null

let pendingAuthCallback: string | null = null

const uiState: UiState = {
  mode: 'chat',
  window: 'full',
  conversationId: null,
}

let fullWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let mouseHook: MouseHookManager | null = null
let localHostRunner: ReturnType<typeof createLocalHostRunner> | null = null
let deviceId: string | null = null
let stellarHomePath: string | null = null
let appReady = false // true when authenticated + onboarding complete
let pendingConvexUrl: string | null = null
let pendingChatContext: ChatContext | null = null
let lastRadialPoint: { x: number; y: number } | null = null
let regionCaptureDisplay: Display | null = null
let pendingRegionCaptureResolve: ((value: ScreenshotCapture | null) => void) | null = null
let pendingRegionCapturePromise: Promise<ScreenshotCapture | null> | null = null
const pendingCredentialRequests = new Map<
  string,
  {
    resolve: (value: CredentialResponsePayload) => void
    reject: (reason?: Error) => void
    timeout: NodeJS.Timeout
  }
>()

const miniSize = {
  width: 680,
  height: 420,
}

const RADIAL_SIZE = 280

const broadcastUiState = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ui:state', uiState)
  }
}

const broadcastAuthCallback = (url: string) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('auth:callback', { url })
  }
}

const handleAuthCallback = (url: string) => {
  if (!url) {
    return
  }
  pendingAuthCallback = url
  if (app.isReady()) {
    showWindow('full')
    broadcastAuthCallback(url)
    pendingAuthCallback = null
  }
}

const registerAuthProtocol = () => {
  if (isDev) {
    const appPath = path.resolve(process.argv[1] ?? '')
    if (appPath) {
      app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [appPath])
    }
    return
  }
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const url = getDeepLinkUrl(argv)
    if (url) {
      handleAuthCallback(url)
    }
    if (fullWindow) {
      fullWindow.focus()
    }
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleAuthCallback(url)
})

const updateUiState = (partial: Partial<UiState>) => {
  Object.assign(uiState, partial)
  broadcastUiState()
}

const getDevUrl = (windowMode: WindowMode) => {
  const url = new URL('http://localhost:5173')
  url.searchParams.set('window', windowMode)
  return url.toString()
}

const getFileTarget = (windowMode: WindowMode) => ({
  filePath: path.join(__dirname, '../dist/index.html'),
  query: { window: windowMode },
})

const loadWindow = (window: BrowserWindow, windowMode: WindowMode) => {
  if (isDev) {
    window.loadURL(getDevUrl(windowMode))
    return
  }

  const target = getFileTarget(windowMode)
  window.loadFile(target.filePath, { query: target.query })
}

const createFullWindow = () => {
  const isMac = process.platform === 'darwin'
  const isWindows = process.platform === 'win32'

  fullWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 300,
    // Custom title bar: frameless on Windows/Linux, hidden inset on macOS
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    ...(isWindows || process.platform === 'linux' ? { frame: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:stellar',
    },
  })

  loadWindow(fullWindow, 'full')
  if (isDev) {
    fullWindow.webContents.openDevTools()
  }

  fullWindow.on('closed', () => {
    fullWindow = null
  })
}

const positionMiniWindow = () => {
  if (!miniWindow) {
    return
  }
  const anchor = fullWindow ?? miniWindow
  const display = anchor ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea

  // Center horizontally, position near bottom of screen
  const targetX = Math.round(x + (width - miniSize.width) / 2)
  const targetY = Math.round(y + height - miniSize.height - 20)

  miniWindow.setBounds({
    x: targetX,
    y: targetY,
    width: miniSize.width,
    height: miniSize.height,
  })
}

const createMiniWindow = () => {
  miniWindow = new BrowserWindow({
    width: miniSize.width,
    height: miniSize.height,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:stellar',
    },
  })

  // Set higher alwaysOnTop level to appear above other floating windows
  miniWindow.setAlwaysOnTop(true, 'pop-up-menu')

  loadWindow(miniWindow, 'mini')

  miniWindow.on('closed', () => {
    miniWindow = null
  })

  // Blur event hides mini window (like Spotlight)
  miniWindow.on('blur', () => {
    if (miniWindow && miniWindow.isVisible()) {
      miniWindow.hide()
    }
  })

  positionMiniWindow()
  miniWindow.hide()
}

const showWindow = (target: WindowMode) => {
  if (target === 'mini') {
    if (!appReady) return // Block mini shell when not signed in or onboarding incomplete
    if (!miniWindow) {
      createMiniWindow()
    }
    positionMiniWindow()
    miniWindow?.show()
    miniWindow?.focus()
    fullWindow?.hide()
    updateUiState({ window: target })
  } else {
    if (!fullWindow) {
      createFullWindow()
    }
    fullWindow?.show()
    fullWindow?.focus()
    miniWindow?.hide()
    // Full view is always chat mode
    updateUiState({ window: target, mode: 'chat' })
  }
}

const captureRadialContext = async (x: number, y: number) => {
  lastRadialPoint = { x, y }
  try {
    pendingChatContext = await captureChatContext({ x, y })
  } catch (error) {
    console.warn('Failed to capture chat context', error)
    pendingChatContext = null
  }
}


const consumeChatContext = () => {
  const context = pendingChatContext
  pendingChatContext = null
  return context
}

const broadcastChatContext = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('chatContext:updated', pendingChatContext)
  }
}

const getDisplayForPoint = (point?: { x: number; y: number }) => {
  const targetPoint = point ?? lastRadialPoint ?? screen.getCursorScreenPoint()
  return screen.getDisplayNearestPoint(targetPoint)
}

const getDisplaySource = async (display: Display) => {
  const scaleFactor = display.scaleFactor ?? 1
  const thumbnailSize = {
    width: Math.floor(display.size.width * scaleFactor),
    height: Math.floor(display.size.height * scaleFactor),
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
  })

  const preferred = sources.find((source) => source.display_id === String(display.id))
  const source = preferred ?? sources[0]
  if (!source) {
    return null
  }

  return { source, scaleFactor }
}

const captureDisplayScreenshot = async (display: Display): Promise<ScreenshotCapture | null> => {
  const result = await getDisplaySource(display)
  if (!result) return null

  const image = result.source.thumbnail
  const png = image.toPNG()
  const size = image.getSize()

  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: size.width,
    height: size.height,
  }
}

const captureRegionScreenshot = async (
  display: Display,
  selection: RegionSelection,
): Promise<ScreenshotCapture | null> => {
  const result = await getDisplaySource(display)
  if (!result) return null

  const image = result.source.thumbnail
  const size = image.getSize()
  const cropX = Math.max(0, Math.round(selection.x * result.scaleFactor))
  const cropY = Math.max(0, Math.round(selection.y * result.scaleFactor))
  const cropWidth = Math.min(size.width - cropX, Math.round(selection.width * result.scaleFactor))
  const cropHeight = Math.min(size.height - cropY, Math.round(selection.height * result.scaleFactor))

  if (cropWidth <= 0 || cropHeight <= 0) {
    return null
  }

  const cropped = image.crop({
    x: cropX,
    y: cropY,
    width: cropWidth,
    height: cropHeight,
  })
  const png = cropped.toPNG()
  const cropSize = cropped.getSize()

  return {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    width: cropSize.width,
    height: cropSize.height,
  }
}

const resetRegionCapture = () => {
  pendingRegionCaptureResolve = null
  pendingRegionCapturePromise = null
  regionCaptureDisplay = null
  hideRegionCaptureWindow()
}

const startRegionCapture = async () => {
  if (pendingRegionCapturePromise) {
    return pendingRegionCapturePromise
  }

  regionCaptureDisplay = getDisplayForPoint()
  showRegionCaptureWindow(regionCaptureDisplay)

  pendingRegionCapturePromise = new Promise<ScreenshotCapture | null>((resolve) => {
    pendingRegionCaptureResolve = resolve
  })

  return pendingRegionCapturePromise
}

const finalizeRegionCapture = async (selection: RegionSelection) => {
  if (!pendingRegionCaptureResolve) {
    resetRegionCapture()
    return
  }

  const display = regionCaptureDisplay ?? getDisplayForPoint()
  const screenshot = await captureRegionScreenshot(display, selection)
  pendingRegionCaptureResolve(screenshot)
  resetRegionCapture()
}

const cancelRegionCapture = () => {
  if (pendingRegionCaptureResolve) {
    pendingRegionCaptureResolve(null)
  }
  resetRegionCapture()
}

// Handle radial wedge selection
const handleRadialSelection = async (wedge: RadialWedge) => {
  switch (wedge) {
    case 'dismiss':
      // Center/dismiss: clear context and do nothing else
      pendingChatContext = null
      break
    case 'capture': {
      updateUiState({ mode: 'chat' })
      const regionScreenshot = await startRegionCapture()
      if (regionScreenshot) {
        const baseContext: ChatContext = pendingChatContext ?? {
          window: null,
          browserUrl: null,
          selectedText: null,
          regionScreenshot: null,
        }
        pendingChatContext = { ...baseContext, regionScreenshot }
      }
      showWindow('mini')
      broadcastChatContext()
      break
    }
    case 'chat':
    case 'auto':
      updateUiState({ mode: 'chat' })
      showWindow('mini')
      broadcastChatContext()
      break
    case 'voice':
      updateUiState({ mode: 'voice' })
      showWindow('mini')
      broadcastChatContext()
      break
    case 'full':
      pendingChatContext = null
      showWindow('full')
      break
  }
}

// Initialize mouse hook
const initMouseHook = () => {
  mouseHook = new MouseHookManager({
    onModifierDown: () => {},
    onModifierUp: () => {
      // Clear any unused context (overlay hiding is handled by onRadialHide)
      pendingChatContext = null
    },
    onLeftClick: (x: number, y: number) => {
      // Hide mini window if clicking outside its bounds
      if (miniWindow && miniWindow.isVisible()) {
        const bounds = miniWindow.getBounds()
        const display = screen.getDisplayNearestPoint({ x, y })
        const scaleFactor = display.scaleFactor ?? 1
        const clickX = x / scaleFactor
        const clickY = y / scaleFactor
        
        const isOutside = 
          clickX < bounds.x || 
          clickX > bounds.x + bounds.width ||
          clickY < bounds.y || 
          clickY > bounds.y + bounds.height
        
        if (isOutside) {
          miniWindow.hide()
        }
      }
    },
    onRadialShow: async (x: number, y: number) => {
      if (!appReady) return
      // 1. Capture selected text first (while original app has focus, ~50ms)
      await captureRadialContext(x, y)
      // 2. Show overlay to block context menu on mouseup
      showModifierOverlay()
      // 3. Show radial on top of overlay
      showRadialWindow(x, y)
    },
    onRadialHide: () => {
      hideRadialWindow()
      hideModifierOverlay()
    },
    onMouseMove: (x: number, y: number) => {
      updateRadialCursor(x, y)
    },
    onMouseUp: (x: number, y: number) => {
      const display = screen.getDisplayNearestPoint({ x, y })
      const scaleFactor = display.scaleFactor ?? 1
      const cursorX = x / scaleFactor
      const cursorY = y / scaleFactor

      // Get radial window bounds to calculate relative position
      const radialWin = getRadialWindow()
      if (radialWin) {
        const bounds = radialWin.getBounds()
        const relativeX = cursorX - bounds.x
        const relativeY = cursorY - bounds.y

        const wedge = calculateSelectedWedge(
          relativeX,
          relativeY,
          RADIAL_SIZE / 2,
          RADIAL_SIZE / 2
        )

        // Always a valid wedge (center = 'dismiss')
        void handleRadialSelection(wedge)
      }
    },
  })

  mouseHook.start()
}

const configureLocalHost = (convexUrl: string) => {
  pendingConvexUrl = convexUrl
  if (localHostRunner) {
    localHostRunner.setConvexUrl(convexUrl)
  }
}

const requestCredential = async (
  payload: Omit<CredentialRequestPayload, 'requestId'>,
) => {
  const requestId = crypto.randomUUID()
  const request: CredentialRequestPayload = { requestId, ...payload }

  const focused = BrowserWindow.getFocusedWindow()
  const targetWindows = focused ? [focused] : fullWindow ? [fullWindow] : BrowserWindow.getAllWindows()
  if (targetWindows.length === 0) {
    throw new Error('No window available to collect credentials.')
  }

  for (const window of targetWindows) {
    window.webContents.send('credential:request', request)
  }

  return new Promise<CredentialResponsePayload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCredentialRequests.delete(requestId)
      reject(new Error('Credential request timed out.'))
    }, 5 * 60 * 1000)
    pendingCredentialRequests.set(requestId, { resolve, reject, timeout })
  })
}

app.whenReady().then(async () => {
  registerAuthProtocol()
  
  // Start persistent PowerShell process for fast selected text capture
  initSelectedTextProcess()
  
  const initialAuthUrl = getDeepLinkUrl(process.argv)
  if (initialAuthUrl) {
    pendingAuthCallback = initialAuthUrl
  }
  const stellarHome = await resolveStellarHome(app)
  stellarHomePath = stellarHome.homePath
  deviceId = await getOrCreateDeviceId(stellarHome.statePath)
  localHostRunner = createLocalHostRunner({
    deviceId,
    stellarHome: stellarHome.homePath,
    requestCredential,
  })
  if (pendingConvexUrl) {
    localHostRunner.setConvexUrl(pendingConvexUrl)
  }
  localHostRunner.start()

  createFullWindow()
  createMiniWindow()
  createRadialWindow() // Pre-create radial window for faster display
  createModifierOverlay() // Overlay to capture right-clicks when Ctrl is held
  showWindow('full')

  if (pendingAuthCallback) {
    broadcastAuthCallback(pendingAuthCallback)
    pendingAuthCallback = null
  }

  // Initialize mouse hook for global right-click detection
  initMouseHook()

  ipcMain.on('app:setReady', (_event, ready: boolean) => {
    appReady = !!ready
  })

  ipcMain.handle('device:getId', () => deviceId)
  ipcMain.handle('host:configure', (_event, config: { convexUrl?: string }) => {
    if (config?.convexUrl) {
      configureLocalHost(config.convexUrl)
    }
    return { deviceId }
  })
  ipcMain.handle('auth:setToken', (_event, payload: { token: string | null }) => {
    localHostRunner?.setAuthToken(payload?.token ?? null)
    return { ok: true }
  })


  // Window control handlers for custom title bar
  ipcMain.on('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })
  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.close()
  })
  ipcMain.handle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })

  ipcMain.handle('ui:getState', () => uiState)
  ipcMain.handle('ui:setState', (_event, partial: Partial<UiState>) => {
    const { window: nextWindow, ...rest } = partial
    if (nextWindow) {
      showWindow(nextWindow)
    }
    if (Object.keys(rest).length > 0) {
      updateUiState(rest)
    }
    return uiState
  })
  ipcMain.on('window:show', (_event, target: WindowMode) => {
    if (target !== 'mini' && target !== 'full') {
      return
    }
    showWindow(target)
  })

  ipcMain.handle('chatContext:get', () => consumeChatContext())

  ipcMain.on('region:select', (_event, selection: RegionSelection) => {
    void finalizeRegionCapture(selection)
  })

  ipcMain.on('region:cancel', () => {
    cancelRegionCapture()
  })

  // Theme sync across windows
  ipcMain.on('theme:broadcast', (_event, data: { key: string; value: string }) => {
    // Broadcast theme changes to all windows except the sender
    const sender = BrowserWindow.fromWebContents(_event.sender)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== sender) {
        window.webContents.send('theme:change', data)
      }
    }
  })

  ipcMain.handle('credential:submit', (_event, payload: CredentialResponsePayload) => {
    const pending = pendingCredentialRequests.get(payload.requestId)
    if (!pending) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(pending.timeout)
    pendingCredentialRequests.delete(payload.requestId)
    pending.resolve(payload)
    return { ok: true }
  })

  ipcMain.handle('credential:cancel', (_event, payload: { requestId: string }) => {
    const pending = pendingCredentialRequests.get(payload.requestId)
    if (!pending) {
      return { ok: false, error: 'Credential request not found.' }
    }
    clearTimeout(pending.timeout)
    pendingCredentialRequests.delete(payload.requestId)
    pending.reject(new Error('Credential request cancelled.'))
    return { ok: true }
  })

  // Browser data collection for core memory
  ipcMain.handle('browserData:exists', async () => {
    if (!stellarHomePath) return false
    return coreMemoryExists(stellarHomePath)
  })

  ipcMain.handle('browserData:collect', async (): Promise<{
    data: BrowserData | null
    formatted: string | null
    error?: string
  }> => {
    if (!stellarHomePath) {
      return { data: null, formatted: null, error: 'Stellar home not initialized' }
    }
    try {
      const data = await collectBrowserData(stellarHomePath)
      const formatted = formatBrowserDataForSynthesis(data)
      return { data, formatted }
    } catch (error) {
      return {
        data: null,
        formatted: null,
        error: (error as Error).message,
      }
    }
  })

  ipcMain.handle('browserData:writeCoreMemory', async (_event, content: string) => {
    if (!stellarHomePath) {
      return { ok: false, error: 'Stellar home not initialized' }
    }
    try {
      await writeCoreMemory(stellarHomePath, content)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  // Comprehensive user signal collection
  ipcMain.handle('signals:collectAll', async (): Promise<AllUserSignalsResult> => {
    if (!stellarHomePath) {
      return { data: null, formatted: null, error: 'Stellar home not initialized' }
    }
    return collectAllSignals(stellarHomePath)
  })

  ipcMain.handle('screenshot:capture', async (_event, point?: { x: number; y: number }) => {
    const display = getDisplayForPoint(point)
    return captureDisplayScreenshot(display)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createFullWindow()
      createMiniWindow()
    }
    showWindow('full')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  cleanupSelectedTextProcess()
  destroyModifierOverlay()
})

app.on('will-quit', () => {
  // Stop mouse hook before quitting
  if (mouseHook) {
    mouseHook.stop()
    mouseHook = null
  }
  if (localHostRunner) {
    localHostRunner.stop()
    localHostRunner = null
  }
})
