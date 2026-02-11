import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell, type Display } from 'electron'
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
import { createRegionCaptureWindow, showRegionCaptureWindow, hideRegionCaptureWindow, getRegionCaptureWindow } from './region-capture-window.js'
import { captureChatContext, type ChatContext } from './chat-context.js'
import { captureWindowAtPoint, prefetchWindowSources, type WindowInfo } from './window-capture.js'
import { initSelectedTextProcess, cleanupSelectedTextProcess, getSelectedText } from './selected-text.js'
import {
  createModifierOverlay,
  showModifierOverlay,
  showModifierOverlayPreemptive,
  hideModifierOverlay,
  destroyModifierOverlay,
} from './modifier-overlay.js'
import { getOrCreateDeviceId } from './local-host/device.js'
import { createLocalHostRunner } from './local-host/runner.js'
import { resolveStellaHome } from './local-host/stella-home.js'
import {
  collectBrowserData,
  coreMemoryExists,
  writeCoreMemory,
  formatBrowserDataForSynthesis,
  type BrowserData,
} from './local-host/browser-data.js'
import { collectAllSignals } from './local-host/collect-all.js'
import type { AllUserSignalsResult } from './local-host/types.js'
import {
  handleInstallCanvas,
  handleInstallPlugin,
  handleInstallSkill,
  handleInstallTheme,
  handleUninstallPackage,
} from './local-host/tools_store.js'
import * as bridgeManager from './local-host/bridge_manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type UiMode = 'chat' | 'voice'
type WindowMode = 'full' | 'mini'

type UiState = {
  mode: UiMode
  window: WindowMode
  view: 'chat' | 'store'
  conversationId: string | null
}

type ScreenshotCapture = {
  dataUrl: string
  width: number
  height: number
}

type RegionCaptureResult = {
  screenshot: ScreenshotCapture | null
  window: ChatContext['window']
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
const AUTH_PROTOCOL = 'Stella'

const getDeepLinkUrl = (argv: string[]) =>
  // Case-insensitive check for the protocol (Windows may lowercase it)
  argv.find((arg) => arg.toLowerCase().startsWith(`${AUTH_PROTOCOL.toLowerCase()}://`)) || null

let pendingAuthCallback: string | null = null

const uiState: UiState = {
  mode: 'chat',
  window: 'full',
  view: 'chat',
  conversationId: null,
}

let fullWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let mouseHook: MouseHookManager | null = null
let localHostRunner: ReturnType<typeof createLocalHostRunner> | null = null
let deviceId: string | null = null
let StellaHomePath: string | null = null
let appReady = false // true when authenticated + onboarding complete
let isQuitting = false
let pendingConvexUrl: string | null = null
let pendingChatContext: ChatContext | null = null
// Bump when pendingChatContext changes so we can avoid broadcasting the same payload
// right before showing the mini window (which can cause a visible "flash" of old state).
let chatContextVersion = 0
let lastBroadcastChatContextVersion = -1
let lastMiniChatContextAckVersion = -1
let pendingMiniChatContextAck:
  | { version: number; resolve: () => void; timeout: NodeJS.Timeout }
  | null = null
let lastRadialPoint: { x: number; y: number } | null = null
let pendingMiniShowTimer: NodeJS.Timeout | null = null
let miniShowRequestId = 0
let pendingMiniBlurHideTimer: NodeJS.Timeout | null = null
let suppressMiniBlurUntil = 0
let pendingMiniOpacityHideTimer: NodeJS.Timeout | null = null
let miniVisible = false
let miniVisibilitySent = false
let miniConcealedForCapture = false
let miniRestoreFocusAfterCapture = false
let miniVisibilityEpoch = 0
let radialSelectionCommitted = false
let radialGestureActive = false
let radialStartedWithMiniVisible = false
let radialContextBeforeGesture: ChatContext | null = null
let radialCaptureRequestId = 0
let pendingRadialCapturePromise: Promise<void> | null = null
let stagedRadialChatContext: ChatContext | null = null
let radialContextShouldCommit = false
let regionCaptureDisplay: Display | null = null
let pendingRegionCaptureResolve: ((value: RegionCaptureResult | null) => void) | null = null
let pendingRegionCapturePromise: Promise<RegionCaptureResult | null> | null = null
const pendingCredentialRequests = new Map<
  string,
  {
    resolve: (value: CredentialResponsePayload) => void
    reject: (reason?: Error) => void
    timeout: NodeJS.Timeout
  }
>()

const emptyContext = (): ChatContext => ({
  window: null,
  browserUrl: null,
  selectedText: null,
  regionScreenshots: [],
})

const toChatContextWindow = (windowInfo: WindowInfo | null | undefined): ChatContext['window'] => {
  if (!windowInfo || (!windowInfo.title && !windowInfo.process)) {
    return null
  }
  return {
    title: windowInfo.title,
    app: windowInfo.process,
    bounds: windowInfo.bounds,
  }
}

const miniSize = {
  width: 680,
  height: 420,
}

const RADIAL_SIZE = 280
const MINI_SHELL_ANIM_MS = 140
const CAPTURE_OVERLAY_HIDE_DELAY_MS = 80

const isMiniShowing = () => {
  return Boolean(miniWindow && miniVisible)
}

const sendMiniVisibility = (visible: boolean, force = false) => {
  if (!miniWindow) return
  if (!force && miniVisibilitySent === visible) return
  miniVisibilitySent = visible
  miniWindow.webContents.send('mini:visibility', { visible })
}

const hideMiniWindow = (animate = true) => {
  if (!miniWindow) return
  const hideEpoch = ++miniVisibilityEpoch
  miniVisible = false
  miniConcealedForCapture = false
  miniRestoreFocusAfterCapture = false
  if (pendingMiniOpacityHideTimer) {
    clearTimeout(pendingMiniOpacityHideTimer)
    pendingMiniOpacityHideTimer = null
  }
  // Keep the window "shown" but invisible so Windows doesn't flash a cached old frame
  // next time we call show(). Also keep it click-through and non-focusable.
  sendMiniVisibility(false)
  miniWindow.setIgnoreMouseEvents(true, { forward: true })
  miniWindow.setFocusable(false)
  // Explicitly blur so isFocused() returns false in the timer callback
  miniWindow.blur()

  if (!animate) {
    miniWindow.setOpacity(0)
    return
  }

  // Let the renderer animate the panel out; then make the window fully transparent.
  if (miniWindow.getOpacity() <= 0.01) {
    return
  }

  pendingMiniOpacityHideTimer = setTimeout(() => {
    if (hideEpoch !== miniVisibilityEpoch) {
      return
    }
    pendingMiniOpacityHideTimer = null
    if (!miniWindow) return
    // Only fully hide if it didn't get re-opened in the meantime.
    if (!miniWindow.isFocused()) {
      miniWindow.setOpacity(0)
    }
  }, MINI_SHELL_ANIM_MS)
}

const concealMiniWindowForCapture = () => {
  if (!miniWindow || !miniVisible || miniConcealedForCapture) {
    return false
  }

  if (pendingMiniOpacityHideTimer) {
    clearTimeout(pendingMiniOpacityHideTimer)
    pendingMiniOpacityHideTimer = null
  }
  if (pendingMiniBlurHideTimer) {
    clearTimeout(pendingMiniBlurHideTimer)
    pendingMiniBlurHideTimer = null
  }

  suppressMiniBlurUntil = Date.now() + 250
  miniRestoreFocusAfterCapture = miniWindow.isFocused()
  miniConcealedForCapture = true
  miniWindow.setIgnoreMouseEvents(true, { forward: true })
  miniWindow.setFocusable(false)
  miniWindow.setOpacity(0)
  return true
}

const restoreMiniWindowAfterCapture = () => {
  if (!miniWindow || !miniVisible || !miniConcealedForCapture) {
    return
  }

  miniVisibilityEpoch += 1
  miniConcealedForCapture = false
  suppressMiniBlurUntil = Date.now() + 250
  miniWindow.setIgnoreMouseEvents(false)
  miniWindow.setFocusable(true)
  miniWindow.setOpacity(1)
  miniWindow.show()
  if (miniRestoreFocusAfterCapture) {
    miniWindow.focus()
  } else {
    miniWindow.showInactive()
  }
  miniRestoreFocusAfterCapture = false
}

const broadcastUiState = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('ui:state', uiState)
  }
}


const setPendingChatContext = (next: ChatContext | null) => {
  pendingChatContext = next
  chatContextVersion += 1
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
    // In dev mode, we need to pass the project directory so Electron can find package.json
    const projectDir = path.resolve(__dirname, '..')
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [projectDir])
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

const isAppUrl = (url: string) => {
  if (url.startsWith('http://localhost:')) return true
  if (url.startsWith('file://')) return true
  if (url === 'about:blank') return true
  return false
}

const setupExternalLinkHandlers = (window: BrowserWindow) => {
  // Intercept target="_blank" / window.open — open in default browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Prevent in-app navigation to external URLs
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
}

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
      partition: 'persist:Stella',
    },
  })

  setupExternalLinkHandlers(fullWindow)
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
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:Stella',
    },
  })

  // Set higher alwaysOnTop level to appear above other floating windows
  miniWindow.setAlwaysOnTop(true, 'pop-up-menu')

  setupExternalLinkHandlers(miniWindow)
  loadWindow(miniWindow, 'mini')

  miniWindow.on('closed', () => {
    miniWindow = null
    miniVisible = false
    miniVisibilitySent = false
    miniConcealedForCapture = false
    miniRestoreFocusAfterCapture = false
  })

  // Prevent destroying the mini window (re-creating transparent windows can cause visible flashes).
  // We still allow it to close during app shutdown.
  miniWindow.on('close', (event) => {
    if (isQuitting) {
      return
    }
    event.preventDefault()
    hideMiniWindow(false)
  })

  // Blur event hides mini window (like Spotlight)
  miniWindow.on('blur', () => {
    if (isMiniShowing()) {
      // Focus can bounce between the radial/overlay and mini during fast selections.
      // Don't dismiss on transient blur during the open handshake.
      if (
        Date.now() < suppressMiniBlurUntil ||
        radialGestureActive ||
        miniConcealedForCapture ||
        Boolean(pendingRegionCapturePromise)
      ) {
        return
      }
      if (pendingMiniBlurHideTimer) {
        clearTimeout(pendingMiniBlurHideTimer)
      }
      pendingMiniBlurHideTimer = setTimeout(() => {
        pendingMiniBlurHideTimer = null
        if (!miniWindow) {
          return
        }
        if (
          Date.now() < suppressMiniBlurUntil ||
          radialGestureActive ||
          miniConcealedForCapture ||
          Boolean(pendingRegionCapturePromise)
        ) {
          return
        }
        if (!miniWindow.isFocused() && isMiniShowing()) {
          hideMiniWindow(true)
        }
      }, 50)
    }
  })

  positionMiniWindow()
  // Keep the window alive/paintable but invisible to avoid cached-frame flashes on fast open.
  hideMiniWindow(false)
  miniWindow.showInactive()
}

const showWindow = (target: WindowMode) => {
  if (target === 'mini') {
    if (!appReady) return // Block mini shell when not signed in or onboarding incomplete
    if (!miniWindow) {
      createMiniWindow()
    }
    if (pendingMiniOpacityHideTimer) {
      clearTimeout(pendingMiniOpacityHideTimer)
      pendingMiniOpacityHideTimer = null
    }
    if (pendingMiniBlurHideTimer) {
      clearTimeout(pendingMiniBlurHideTimer)
      pendingMiniBlurHideTimer = null
    }
    miniVisibilityEpoch += 1

    if (isMiniShowing() && !miniConcealedForCapture) {
      suppressMiniBlurUntil = Date.now() + 250
      positionMiniWindow()
      if (lastBroadcastChatContextVersion !== chatContextVersion) {
        broadcastChatContext()
      }
      miniWindow?.setIgnoreMouseEvents(false)
      miniWindow?.setFocusable(true)
      miniWindow?.setOpacity(1)
      miniWindow?.show()
      miniWindow?.focus()
      sendMiniVisibility(true)
      updateUiState({ window: target })
      return
    }

    const requestId = ++miniShowRequestId
    // Give the mini window a short blur-grace period while we transition away from the radial/overlay.
    suppressMiniBlurUntil = Date.now() + 250
    // Push the latest context before the window becomes visible to avoid flashing stale selection text.
    // If the context was already broadcast during the current radial interaction, skip the duplicate send.
    if (lastBroadcastChatContextVersion !== chatContextVersion) {
      broadcastChatContext()
    }
    positionMiniWindow()

    // Defer showing by a tick so the renderer can process the chatContext update while hidden.
    if (pendingMiniShowTimer) {
      clearTimeout(pendingMiniShowTimer)
    }
    pendingMiniShowTimer = setTimeout(() => {
      pendingMiniShowTimer = null
      const versionToWait = chatContextVersion
      void (async () => {
        // Show the window fully transparent first so Windows doesn't display a cached old frame.
        // We'll restore opacity after the renderer acks that it applied the latest chatContext.
        fullWindow?.hide()
        miniWindow?.setIgnoreMouseEvents(false)
        miniWindow?.setFocusable(true)
        miniWindow?.setOpacity(0)
        miniWindow?.show()
        miniWindow?.focus()

        await waitForMiniChatContext(versionToWait)

        // If a newer show request arrived, don't "commit" this one.
        if (requestId !== miniShowRequestId) {
          // Make sure we don't leave the window invisible if it was shown.
          if (miniWindow?.isVisible()) {
            miniWindow.setOpacity(1)
          }
          return
        }

        // Ensure the window is interactive in case a transient blur hid it during the handshake.
        miniWindow?.setIgnoreMouseEvents(false)
        miniWindow?.setFocusable(true)
        // Trigger renderer "panel in" animation, then reveal the window.
        miniVisible = true
        miniConcealedForCapture = false
        miniRestoreFocusAfterCapture = false
        sendMiniVisibility(true)
        setTimeout(() => {
          // If a newer show request arrived, don't reveal for the old one.
          if (requestId !== miniShowRequestId) return
          miniWindow?.setOpacity(1)
        }, 16)
        updateUiState({ window: target })
      })()
    }, 0)
  } else {
    if (pendingMiniShowTimer) {
      clearTimeout(pendingMiniShowTimer)
      pendingMiniShowTimer = null
    }
    if (!fullWindow) {
      createFullWindow()
    }
    const win = fullWindow
    if (win) {
      if (win.isMinimized()) {
        win.restore()
      }
      if (process.platform === 'win32') {
        app.focus({ steal: true })
        win.show()
        win.moveTop()
        // Pulse always-on-top to reliably lift above other apps.
        win.setAlwaysOnTop(true, 'screen-saver')
        win.focus()
        setTimeout(() => {
          if (!win.isDestroyed()) {
            win.setAlwaysOnTop(false)
          }
        }, 75)
      } else {
        win.show()
        win.focus()
      }
    }
    hideMiniWindow(false)
    // Full view is always chat mode
    updateUiState({ window: target, mode: 'chat' })
  }
}

const cancelRadialContextCapture = () => {
  radialCaptureRequestId += 1
  pendingRadialCapturePromise = null
  stagedRadialChatContext = null
  radialContextShouldCommit = false
}

const commitStagedRadialContext = () => {
  if (!radialContextShouldCommit || !stagedRadialChatContext) {
    return
  }

  const screenshots =
    pendingChatContext?.regionScreenshots ??
    radialContextBeforeGesture?.regionScreenshots ??
    []

  setPendingChatContext({
    ...stagedRadialChatContext,
    regionScreenshots: screenshots,
  })
  stagedRadialChatContext = null
  radialContextShouldCommit = false

  if (isMiniShowing()) {
    broadcastChatContext()
  }
}

const captureRadialContext = (x: number, y: number) => {
  const requestId = ++radialCaptureRequestId
  lastRadialPoint = { x, y }
  stagedRadialChatContext = null
  const existingScreenshots =
    pendingChatContext?.regionScreenshots ??
    radialContextBeforeGesture?.regionScreenshots ??
    []

  pendingRadialCapturePromise = (async () => {
    try {
      const fresh = await captureChatContext(
        { x, y },
        { excludeCurrentProcessWindows: true },
      )
      if (requestId !== radialCaptureRequestId) {
        return
      }

      // Preserve screenshots captured while text capture was running.
      const screenshots = pendingChatContext?.regionScreenshots ?? existingScreenshots
      stagedRadialChatContext = {
        ...fresh,
        regionScreenshots: screenshots,
      }
    } catch (error) {
      if (requestId !== radialCaptureRequestId) {
        return
      }
      console.warn('Failed to capture chat context', error)
      const screenshots = pendingChatContext?.regionScreenshots ?? existingScreenshots
      stagedRadialChatContext = {
        window: null,
        browserUrl: null,
        selectedText: null,
        regionScreenshots: screenshots,
      }
    } finally {
      if (requestId === radialCaptureRequestId) {
        pendingRadialCapturePromise = null
        commitStagedRadialContext()
      }
    }
  })()
}


const getChatContextSnapshot = () => pendingChatContext

const broadcastChatContext = () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('chatContext:updated', {
      context: pendingChatContext,
      version: chatContextVersion,
    })
  }
  lastBroadcastChatContextVersion = chatContextVersion
}

const waitForMiniChatContext = async (version: number, timeoutMs = 250) => {
  if (!miniWindow) {
    return
  }
  if (lastMiniChatContextAckVersion >= version) {
    return
  }

  // Replace any existing waiter (we only care about the latest version).
  if (pendingMiniChatContextAck) {
    clearTimeout(pendingMiniChatContextAck.timeout)
    pendingMiniChatContextAck.resolve()
    pendingMiniChatContextAck = null
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingMiniChatContextAck?.version === version) {
        pendingMiniChatContextAck = null
      }
      resolve()
    }, timeoutMs)

    pendingMiniChatContextAck = {
      version,
      timeout,
      resolve: () => {
        clearTimeout(timeout)
        pendingMiniChatContextAck = null
        resolve()
      },
    }
  })
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

const getCurrentProcessWindowSourceIds = () => {
  const ids: string[] = []
  for (const window of BrowserWindow.getAllWindows()) {
    const id =
      typeof window.getMediaSourceId === 'function'
        ? window.getMediaSourceId()
        : null
    if (id) {
      ids.push(id)
    }
  }
  return ids
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

  regionCaptureDisplay = getDisplayForPoint(screen.getCursorScreenPoint())
  await showRegionCaptureWindow(regionCaptureDisplay, cancelRegionCapture)

  pendingRegionCapturePromise = new Promise<RegionCaptureResult | null>((resolve) => {
    pendingRegionCaptureResolve = resolve
  })

  return pendingRegionCapturePromise
}

const finalizeRegionCapture = async (selection: RegionSelection) => {
  if (!pendingRegionCaptureResolve) {
    resetRegionCapture()
    return
  }

  const resolve = pendingRegionCaptureResolve
  hideRegionCaptureWindow()
  hideRadialWindow()
  hideModifierOverlay()
  const miniWasConcealed = concealMiniWindowForCapture()

  let screenshot: ScreenshotCapture | null = null
  try {
    await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
    const display = regionCaptureDisplay ?? getDisplayForPoint()
    screenshot = await captureRegionScreenshot(display, selection)
  } catch (error) {
    console.warn('Failed to capture selected region', error)
    screenshot = null
  } finally {
    if (miniWasConcealed) {
      restoreMiniWindowAfterCapture()
    }
  }

  resolve({ screenshot, window: null })
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
      // Center/dismiss: cancel this gesture and restore the pre-radial context.
      cancelRadialContextCapture()
      if (radialStartedWithMiniVisible) {
        if (pendingChatContext !== radialContextBeforeGesture) {
          setPendingChatContext(radialContextBeforeGesture)
        }
      } else if (pendingChatContext !== null) {
        setPendingChatContext(null)
      }
      break
    case 'capture': {
      radialContextShouldCommit = true
      commitStagedRadialContext()
      updateUiState({ mode: 'chat' })
      // Hide radial + modifier overlay before entering region capture so they
      // don't appear in the screenshot (desktopCapturer captures composited screen).
      hideRadialWindow()
      hideModifierOverlay()
      const miniWasConcealed = concealMiniWindowForCapture()
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
      const regionCapture = await startRegionCapture()
      if (regionCapture && (regionCapture.screenshot || regionCapture.window)) {
        const ctx = pendingChatContext ?? emptyContext()
        const existing = ctx.regionScreenshots ?? []
        const nextScreenshots = regionCapture.screenshot
          ? [...existing, regionCapture.screenshot]
          : existing
        setPendingChatContext({
          ...ctx,
          window: regionCapture.window ?? ctx.window,
          regionScreenshots: nextScreenshots,
        })
      }
      if (miniWasConcealed) {
        restoreMiniWindowAfterCapture()
      }
      if (!isMiniShowing()) {
        showWindow('mini')
      } else {
        broadcastChatContext()
      }
      break
    }
    case 'chat':
    case 'auto': {
      radialContextShouldCommit = true
      commitStagedRadialContext()
      updateUiState({ mode: 'chat' })
      if (!isMiniShowing()) showWindow('mini')
      break
    }
    case 'voice':
      radialContextShouldCommit = true
      commitStagedRadialContext()
      updateUiState({ mode: 'voice' })
      if (!isMiniShowing()) showWindow('mini')
      break
    case 'full':
      cancelRadialContextCapture()
      setPendingChatContext(null)
      showWindow('full')
      break
  }
}

// Initialize mouse hook
const initMouseHook = () => {
  mouseHook = new MouseHookManager({
    onModifierDown: () => {
      if (process.platform === 'darwin') {
        // On macOS, show the overlay preemptively when Cmd is pressed.
        // macOS fires the context menu at the OS level on right-click before
        // any window can intercept it. By placing the overlay before the
        // right-click happens, the overlay receives (and suppresses) the
        // context menu event instead of the app underneath.
        showModifierOverlayPreemptive()
      }
    },
    onModifierUp: () => {
      // Clear any unused context, but not if the mini shell is already showing
      // (the user selected a wedge and the context is in use)
      if (!isMiniShowing() && !pendingMiniShowTimer && !pendingRadialCapturePromise) {
        setPendingChatContext(null)
      }
      if (process.platform === 'darwin') {
        // Hide preemptive overlay when modifier is released (unless radial is
        // active — onRadialHide will handle cleanup in that case).
        if (!mouseHook?.isRadialActive()) {
          hideModifierOverlay()
        }
      }
    },
    onLeftClick: (x: number, y: number) => {
      if (radialGestureActive || miniConcealedForCapture || pendingRegionCapturePromise) {
        return
      }
      // Hide mini window if clicking outside its bounds
      const win = miniWindow
      if (win && isMiniShowing() && win.getOpacity() > 0.01) {
        const bounds = win.getBounds()
        const display = screen.getDisplayNearestPoint({ x, y })
        // On macOS uiohook coords are already logical; on Windows/Linux divide to convert.
        const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
        const clickX = x / scaleFactor
        const clickY = y / scaleFactor
        
        const isOutside = 
          clickX < bounds.x || 
          clickX > bounds.x + bounds.width ||
          clickY < bounds.y || 
          clickY > bounds.y + bounds.height

        if (isOutside) {
          hideMiniWindow(true)
        }
      }
    },
    onRadialShow: (x: number, y: number) => {
      if (!appReady) return
      // Suppress mini blur so the radial overlay doesn't dismiss an already-open mini shell.
      suppressMiniBlurUntil = Date.now() + 2000
      radialGestureActive = true
      radialStartedWithMiniVisible = isMiniShowing()
      radialContextBeforeGesture = pendingChatContext
      radialContextShouldCommit = false
      stagedRadialChatContext = null
      // Dismiss any open image preview in the mini shell.
      if (isMiniShowing() && miniWindow) {
        miniWindow.webContents.send('mini:dismissPreview')
      }
      if (!radialStartedWithMiniVisible && pendingChatContext) {
        const hasTransientContext = Boolean(
          pendingChatContext.window ||
          pendingChatContext.selectedText ||
          pendingChatContext.browserUrl,
        )
        if (hasTransientContext) {
          setPendingChatContext({
            window: null,
            browserUrl: null,
            selectedText: null,
            regionScreenshots: pendingChatContext.regionScreenshots ?? [],
          })
        }
      }
      radialSelectionCommitted = false
      // 1. Show radial immediately so first-open latency is not gated by
      // selected-text capture.
      showRadialWindow(x, y)
      // 2. Show overlay to block context menu on mouseup.
      showModifierOverlay()
      // 3. Capture context in the background.
      captureRadialContext(x, y)
    },
    onRadialHide: () => {
      // Modifier-up can end the gesture without a mouse-up selection.
      // In that path, ignore any in-flight capture from this gesture.
      if (!radialSelectionCommitted) {
        cancelRadialContextCapture()
        if (radialStartedWithMiniVisible) {
          if (pendingChatContext !== radialContextBeforeGesture) {
            setPendingChatContext(radialContextBeforeGesture)
          }
        } else if (!pendingMiniShowTimer && pendingChatContext !== null) {
          setPendingChatContext(null)
        }
      }
      radialGestureActive = false
      radialSelectionCommitted = false
      hideRadialWindow()
      hideModifierOverlay()
    },
    onMouseMove: (x: number, y: number) => {
      updateRadialCursor(x, y)
    },
    onMouseUp: (x: number, y: number) => {
      const display = screen.getDisplayNearestPoint({ x, y })
      // On macOS uiohook coords are already logical; on Windows/Linux divide to convert.
      const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
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
        radialSelectionCommitted = true
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
  if (process.platform === 'win32') {
    // Warm up the first UI Automation query so the first radial open doesn't pay
    // the cold-call latency spike.
    setTimeout(() => {
      void getSelectedText()
    }, 250)
  }
  
  const initialAuthUrl = getDeepLinkUrl(process.argv)
  if (initialAuthUrl) {
    pendingAuthCallback = initialAuthUrl
  }
  const StellaHome = await resolveStellaHome(app)
  StellaHomePath = StellaHome.homePath
  deviceId = await getOrCreateDeviceId(StellaHome.statePath)
  localHostRunner = createLocalHostRunner({
    deviceId,
    StellaHome: StellaHome.homePath,
    frontendRoot: path.resolve(__dirname, '..'),
    requestCredential,
  })
  if (pendingConvexUrl) {
    localHostRunner.setConvexUrl(pendingConvexUrl)
  }
  localHostRunner.start()

  createFullWindow()
  createMiniWindow()
  createRadialWindow() // Pre-create radial window for faster display
  createRegionCaptureWindow() // Pre-create region capture window for faster display
  createModifierOverlay() // Overlay to capture right-clicks when Ctrl is held
  showWindow('full')

  // Wait for the full window to finish loading before broadcasting auth callback
  // Otherwise the renderer won't be ready to receive the IPC message
  if (pendingAuthCallback && fullWindow) {
    const authUrl = pendingAuthCallback
    pendingAuthCallback = null
    fullWindow.webContents.once('did-finish-load', () => {
      broadcastAuthCallback(authUrl)
    })
  }

  // Initialize mouse hook for global right-click detection
  initMouseHook()

  ipcMain.on('app:setReady', (_event, ready: boolean) => {
    appReady = !!ready
  })

  ipcMain.on('chatContext:ack', (event, payload: { version?: unknown }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!miniWindow || win !== miniWindow) {
      return
    }

    const version = payload?.version
    if (typeof version !== 'number') {
      return
    }

    lastMiniChatContextAckVersion = Math.max(lastMiniChatContextAckVersion, version)
    if (pendingMiniChatContextAck && pendingMiniChatContextAck.version === version) {
      pendingMiniChatContextAck.resolve()
    }
  })

  ipcMain.handle('device:getId', () => deviceId)
  ipcMain.handle('host:configure', (_event, config: { convexUrl?: string }) => {
    if (config?.convexUrl) {
      configureLocalHost(config.convexUrl)
    }
    return { deviceId }
  })
  ipcMain.handle('auth:setToken', (_event, payload: { token: string | null }) => {
    const nextToken = payload?.token ?? null
    localHostRunner?.setAuthToken(nextToken)
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
    if (!win) return

    // For spotlight-style overlays, "close" should dismiss without destroying the window.
    // Destroying/recreating transparent windows can cause visible flashes/flicker.
    if (win === miniWindow) {
      hideMiniWindow(true)
      return
    }

    win.close()
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

  ipcMain.handle('chatContext:get', () => getChatContextSnapshot())

  ipcMain.on('chatContext:removeScreenshot', (_event, index: number) => {
    if (!pendingChatContext?.regionScreenshots) return
    const next = [...pendingChatContext.regionScreenshots]
    next.splice(index, 1)
    setPendingChatContext({ ...pendingChatContext, regionScreenshots: next })
  })

  ipcMain.on('region:select', (_event, selection: RegionSelection) => {
    void finalizeRegionCapture(selection)
  })

  ipcMain.on('region:cancel', () => {
    cancelRegionCapture()
  })

  ipcMain.on('region:click', async (_event, point: { x: number; y: number }) => {
    if (!pendingRegionCaptureResolve) {
      resetRegionCapture()
      return
    }

    // Grab the resolve function before resetting (resetRegionCapture clears it)
    const resolve = pendingRegionCaptureResolve

    // Hide the region capture overlay BEFORE capturing so it doesn't appear in the screenshot
    hideRegionCaptureWindow()
    hideRadialWindow()
    hideModifierOverlay()

    // Temporarily conceal the mini shell (without toggling renderer visibility)
    // so we capture the underlying target window/content.
    const miniWasConcealed = concealMiniWindowForCapture()

    let capture: Awaited<ReturnType<typeof captureWindowAtPoint>> = null
    try {
      // Wait briefly for composited overlays to disappear before capture.
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))

      // Pre-fetch sources with Stella windows excluded.
      const sources = await prefetchWindowSources(getCurrentProcessWindowSourceIds())

      // Convert overlay-local click coordinates into global desktop coordinates.
      // regionWindow bounds are DIP; the native picker expects global coordinates.
      const regionBounds = getRegionCaptureWindow()?.getBounds()
      let capturePoint = { x: point.x, y: point.y }
      if (regionBounds) {
        const dipX = regionBounds.x + point.x
        const dipY = regionBounds.y + point.y
        const scaleFactor = process.platform === 'darwin' ? 1 : (regionCaptureDisplay?.scaleFactor ?? 1)
        capturePoint = {
          x: Math.round(dipX * scaleFactor),
          y: Math.round(dipY * scaleFactor),
        }
      }

      // Capture window at clicked point.
      capture = await captureWindowAtPoint(
        capturePoint.x,
        capturePoint.y,
        sources,
        { excludePids: [process.pid] },
      )
    } catch (error) {
      console.warn('Failed to capture window at point', error)
      capture = null
    } finally {
      if (miniWasConcealed) {
        restoreMiniWindowAfterCapture()
      }
    }

    resolve({
      screenshot: capture?.screenshot ?? null,
      window: toChatContextWindow(capture?.windowInfo),
    })
    pendingRegionCaptureResolve = null
    pendingRegionCapturePromise = null
    regionCaptureDisplay = null
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
    if (!StellaHomePath) return false
    return coreMemoryExists(StellaHomePath)
  })

  ipcMain.handle('browserData:collect', async (): Promise<{
    data: BrowserData | null
    formatted: string | null
    error?: string
  }> => {
    if (!StellaHomePath) {
      return { data: null, formatted: null, error: 'Stella home not initialized' }
    }
    try {
      const data = await collectBrowserData(StellaHomePath)
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
    if (!StellaHomePath) {
      return { ok: false, error: 'Stella home not initialized' }
    }
    try {
      await writeCoreMemory(StellaHomePath, content)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  // Comprehensive user signal collection (with category support)
  ipcMain.handle('signals:collectAll', async (_event, options?: { categories?: string[] }): Promise<AllUserSignalsResult> => {
    if (!StellaHomePath) {
      return { data: null, formatted: null, error: 'Stella home not initialized' }
    }
    const categories = options?.categories as import('./local-host/discovery_types.js').DiscoveryCategory[] | undefined
    return collectAllSignals(StellaHomePath, categories)
  })

  // Identity map for depseudonymization
  ipcMain.handle('identity:getMap', async () => {
    if (!StellaHomePath) return { version: 1, mappings: [] }
    const { loadIdentityMap } = await import('./local-host/identity_map.js')
    return loadIdentityMap(StellaHomePath)
  })

  ipcMain.handle('identity:depseudonymize', async (_event, text: string) => {
    if (!StellaHomePath || !text) return text
    const { loadIdentityMap, depseudonymize } = await import('./local-host/identity_map.js')
    const map = await loadIdentityMap(StellaHomePath)
    if (map.mappings.length === 0) return text
    return depseudonymize(text, map)
  })

  // Open URL in user's default browser
  ipcMain.on('shell:openExternal', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url)
    }
  })

  // Open Full Disk Access in System Preferences (macOS)
  ipcMain.on('system:openFullDiskAccess', () => {
    if (process.platform === 'darwin') {
      import('child_process').then(({ exec: execCmd }) => {
        execCmd('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"')
      })
    }
  })

  // Store package install/uninstall IPC handlers
  const unwrapStoreResult = (result: { result?: unknown; error?: string }) => {
    if (result.error) {
      throw new Error(result.error)
    }
    return result.result ?? {}
  }

  ipcMain.handle('store:installSkill', async (_event, payload: {
    packageId: string; skillId: string; name: string; markdown: string; agentTypes?: string[]; tags?: string[]
  }) => {
    return unwrapStoreResult(await handleInstallSkill(payload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:installTheme', async (_event, payload: {
    packageId: string; themeId: string; name: string; light: Record<string, string>; dark: Record<string, string>
  }) => {
    return unwrapStoreResult(await handleInstallTheme(payload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:installCanvas', async (_event, payload: {
    packageId: string
    workspaceId?: string
    name: string
    dependencies?: Record<string, string>
    source?: string
  }) => {
    return unwrapStoreResult(await handleInstallCanvas(payload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:installPlugin', async (_event, payload: {
    packageId: string
    pluginId?: string
    name?: string
    version?: string
    description?: string
    manifest?: Record<string, unknown>
    files?: Record<string, string>
  }) => {
    return unwrapStoreResult(await handleInstallPlugin(payload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:uninstall', async (_event, payload: {
    packageId: string; type: string; localId: string
  }) => {
    return unwrapStoreResult(await handleUninstallPackage(payload as unknown as Record<string, unknown>))
  })

  // Bridge manager IPC handlers
  ipcMain.handle('bridge:deploy', async (_event, payload: {
    provider: string; code: string; config: string; dependencies: string
  }) => {
    return bridgeManager.deploy(payload)
  })

  ipcMain.handle('bridge:start', async (_event, payload: { provider: string }) => {
    return bridgeManager.start(payload.provider)
  })

  ipcMain.handle('bridge:stop', async (_event, payload: { provider: string }) => {
    return bridgeManager.stop(payload.provider)
  })

  ipcMain.handle('bridge:status', async (_event, payload: { provider: string }) => {
    return { running: bridgeManager.isRunning(payload.provider) }
  })

  ipcMain.handle('shell:killByPort', async (_event, payload: { port: number }) => {
    if (localHostRunner) {
      localHostRunner.killShellsByPort(payload.port)
    }
  })

  ipcMain.handle('theme:listInstalled', async () => {
    const { promises: fs } = await import('fs')
    const os = await import('os')
    const themesDir = path.join(os.homedir(), '.stella', 'themes')
    try {
      const files = await fs.readdir(themesDir)
      const themes = []
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = await fs.readFile(path.join(themesDir, file), 'utf-8')
          const theme = JSON.parse(raw)
          if (theme.id && theme.name && theme.light && theme.dark) {
            themes.push(theme)
          }
        } catch {
          // Skip invalid theme files
        }
      }
      return themes
    } catch {
      return []
    }
  })

  ipcMain.handle('screenshot:capture', async (_event, point?: { x: number; y: number }) => {
    const display = getDisplayForPoint(point)
    const cursorDip = point ?? screen.getCursorScreenPoint()
    const scaleFactor = process.platform === 'darwin' ? 1 : (display.scaleFactor ?? 1)
    const capturePoint = {
      x: Math.round(cursorDip.x * scaleFactor),
      y: Math.round(cursorDip.y * scaleFactor),
    }
    hideRadialWindow()
    hideModifierOverlay()
    hideRegionCaptureWindow()
    const miniWasConcealed = concealMiniWindowForCapture()

    try {
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))
      const sources = await prefetchWindowSources(getCurrentProcessWindowSourceIds())
      const windowCapture = await captureWindowAtPoint(
        capturePoint.x,
        capturePoint.y,
        sources,
        { excludePids: [process.pid] },
      )
      if (windowCapture?.screenshot) {
        return windowCapture.screenshot
      }
      return await captureDisplayScreenshot(display)
    } finally {
      if (miniWasConcealed) {
        restoreMiniWindowAfterCapture()
      }
    }
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
  isQuitting = true
  if (localHostRunner) {
    localHostRunner.killAllShells()
  }
  bridgeManager.stopAll()
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
