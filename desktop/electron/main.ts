import { promises as fs } from 'fs'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, globalShortcut, webContents, type Display, type IpcMainEvent, type IpcMainInvokeEvent, type MessageBoxOptions } from 'electron'
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
import { captureWindowScreenshot, type WindowInfo } from './window-capture.js'
import { initSelectedTextProcess, cleanupSelectedTextProcess, getSelectedText } from './selected-text.js'
import {
  createModifierOverlay,
  showModifierOverlay,
  showModifierOverlayPreemptive,
  hideModifierOverlay,
  destroyModifierOverlay,
} from './modifier-overlay.js'
import {
  getVoiceWindow,
  createVoiceWindow,
  showVoiceWindow,
  hideVoiceWindow,
  resizeVoiceWindow,
} from './voice-window.js'
import { getOrCreateDeviceIdentity, signDeviceHeartbeat } from './local-host/device.js'
import { createLocalHostRunner } from './local-host/runner.js'
import { getDevServerUrl } from './dev-url.js'
import { resolveStellaHome } from './local-host/stella-home.js'
import {
  collectBrowserData,
  coreMemoryExists,
  detectPreferredBrowserProfile,
  listBrowserProfiles,
  writeCoreMemory,
  formatBrowserDataForSynthesis,
  type BrowserData,
  type BrowserType,
} from './local-host/browser-data.js'
import { collectAllSignals } from './local-host/collect-all.js'
import type { AllUserSignalsResult } from './local-host/types.js'
import {
  handleInstallCanvas,
  handleInstallSkill,
  handleInstallTheme,
  handleUninstallPackage,
} from './local-host/tools_store.js'
import * as bridgeManager from './local-host/bridge_manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type UiMode = 'chat' | 'voice'
type WindowMode = 'full' | 'mini' | 'voice'

type UiState = {
  mode: UiMode
  window: WindowMode
  view: 'chat' | 'store'
  conversationId: string | null
  isVoiceActive: boolean
  isVoiceRtcActive: boolean
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
  isVoiceActive: false,
  isVoiceRtcActive: false,
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
let pendingConvexSiteUrl: string | null = null
let hostAuthAuthenticated = false
let authRefreshTimer: NodeJS.Timeout | null = null
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
  width: 480,
  height: 700,
}

const RADIAL_SIZE = 280
const MINI_SHELL_ANIM_MS = 140
const CAPTURE_OVERLAY_HIDE_DELAY_MS = 80
const TOKEN_REFRESH_INTERVAL_MS = 60 * 1000
const STELLA_SESSION_PARTITION = 'persist:Stella'
const SECURITY_POLICY_VERSION = 1
const SECURITY_APPROVAL_PREFIX = `v${SECURITY_POLICY_VERSION}:`
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const STORE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/
const STORE_TOKEN_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/
const STORE_PACKAGE_TYPES = new Set(['skill', 'theme', 'canvas', 'mod'] as const)
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i
const NPM_PACKAGE_VERSION_PATTERN = /^[a-z0-9*^~<>=|.+-]+$/i
const WORKSPACE_PANEL_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.tsx$/
const MAX_STORE_NAME_CHARS = 120
const MAX_STORE_MARKDOWN_CHARS = 250_000
const MAX_STORE_SOURCE_CHARS = 250_000
const MAX_STORE_DEPENDENCIES = 64
const MAX_THEME_TOKENS = 256
const MAX_EXTERNAL_URL_LENGTH = 4096
const EXTERNAL_OPEN_MIN_INTERVAL_MS = 300
const EXTERNAL_OPEN_WINDOW_MS = 15_000
const EXTERNAL_OPEN_MAX_PER_WINDOW = 20
const trustedPrivilegedActions = new Set<string>()
const externalOpenRateBySender = new Map<
  number,
  { windowStartMs: number; count: number; lastOpenedAtMs: number }
>()
let securityPolicyPath: string | null = null

const isMiniShowing = () => {
  return Boolean(miniWindow && miniVisible)
}

const sendMiniVisibility = (visible: boolean, force = false) => {
  if (!miniWindow) return
  if (!force && miniVisibilitySent === visible) return
  miniVisibilitySent = visible
  miniWindow.webContents.send('mini:visibility', { visible })
}

const formatWorkspacePanelTitle = (name: string) => {
  const withoutPrefix = name.replace(/^pd_/, '')
  const parts = withoutPrefix
    .split(/[_-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return name
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const listWorkspacePanels = async () => {
  const pagesDir = path.resolve(__dirname, '..', 'src', 'views', 'home', 'pages')

  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(pagesDir, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[workspace:listPanels] Failed to read pages directory', error)
    }
    return []
  }

  const candidates = entries.filter(
    (entry) => entry.isFile() && WORKSPACE_PANEL_FILE_PATTERN.test(entry.name),
  )

  const withMeta = await Promise.all(
    candidates.map(async (entry) => {
      const fullPath = path.join(pagesDir, entry.name)
      let mtimeMs = 0
      try {
        const stat = await fs.stat(fullPath)
        mtimeMs = stat.mtimeMs
      } catch {
        // Best effort metadata; stale/deleted files are still listable.
      }

      const name = entry.name.slice(0, -4)
      return {
        name,
        title: formatWorkspacePanelTitle(name),
        mtimeMs,
      }
    }),
  )

  return withMeta
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title))
    .map(({ name, title }) => ({ name, title }))
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
  if (!isTrustedAuthCallbackUrl(url)) {
    console.warn('[security] Rejected untrusted auth callback URL.')
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
  const url = new URL(getDevServerUrl())
  url.searchParams.set('window', windowMode)
  return url.toString()
}

const getFileTarget = (windowMode: WindowMode) => ({
  filePath: path.join(__dirname, '../dist/index.html'),
  query: { window: windowMode },
})

const parseUrl = (value: string) => {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.has(hostname.trim().toLowerCase())

const isAppUrl = (url: string) => {
  const parsed = parseUrl(url)
  if (!parsed) return false
  if (parsed.protocol === 'file:') return true
  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return true
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname)) {
    return true
  }
  return false
}

const isTrustedRendererUrl = (url: string) => {
  const parsed = parseUrl(url)
  if (!parsed) return false
  if (parsed.protocol === 'file:') return true
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname)) {
    return true
  }
  return false
}

const normalizeExternalHttpUrl = (value: unknown) => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    return null
  }
  const parsed = parseUrl(trimmed)
  if (!parsed) {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  return trimmed
}

const openSafeExternalUrl = (value: unknown) => {
  const safeUrl = normalizeExternalHttpUrl(value)
  if (!safeUrl) {
    return false
  }
  void shell.openExternal(safeUrl)
  return true
}

const consumeExternalOpenBudget = (senderId: number) => {
  const now = Date.now()
  const existing = externalOpenRateBySender.get(senderId)
  if (!existing || now - existing.windowStartMs > EXTERNAL_OPEN_WINDOW_MS) {
    externalOpenRateBySender.set(senderId, {
      windowStartMs: now,
      count: 1,
      lastOpenedAtMs: now,
    })
    return true
  }
  if (now - existing.lastOpenedAtMs < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
    return false
  }
  if (existing.count >= EXTERNAL_OPEN_MAX_PER_WINDOW) {
    return false
  }
  existing.count += 1
  existing.lastOpenedAtMs = now
  return true
}

const getSenderUrl = (event: IpcMainEvent | IpcMainInvokeEvent) =>
  event.senderFrame?.url || event.sender.getURL() || ''

const assertPrivilegedSender = (
  event: IpcMainEvent | IpcMainInvokeEvent,
  channel: string,
) => {
  const senderUrl = getSenderUrl(event)
  if (isTrustedRendererUrl(senderUrl)) {
    return true
  }
  console.warn(`[security] Blocked privileged IPC "${channel}" from untrusted sender: ${senderUrl || '(unknown)'}`)
  return false
}

const approvalKey = (action: string) => `${SECURITY_APPROVAL_PREFIX}${action}`

const loadSecurityPolicy = async () => {
  if (!securityPolicyPath) return
  try {
    const raw = await fs.readFile(securityPolicyPath, 'utf-8')
    const parsed = JSON.parse(raw) as { approved?: unknown }
    const approved = Array.isArray(parsed?.approved) ? parsed.approved : []
    trustedPrivilegedActions.clear()
    for (const entry of approved) {
      if (typeof entry === 'string' && entry.startsWith(SECURITY_APPROVAL_PREFIX)) {
        trustedPrivilegedActions.add(entry)
      }
    }
  } catch {
    // File missing/invalid -> treat as no approvals.
  }
}

const persistSecurityPolicy = async () => {
  if (!securityPolicyPath) return
  try {
    await fs.mkdir(path.dirname(securityPolicyPath), { recursive: true })
    await fs.writeFile(
      securityPolicyPath,
      JSON.stringify(
        {
          version: SECURITY_POLICY_VERSION,
          approved: [...trustedPrivilegedActions].sort(),
        },
        null,
        2,
      ),
      'utf-8',
    )
  } catch (error) {
    console.warn('[security] Failed to persist security policy', error)
  }
}

const ensurePrivilegedActionApproval = async (
  action: string,
  message: string,
  detail: string,
  event?: IpcMainEvent | IpcMainInvokeEvent,
) => {
  const key = approvalKey(action)
  if (trustedPrivilegedActions.has(key)) {
    return true
  }

  const ownerWindow =
    (event ? BrowserWindow.fromWebContents(event.sender) : null) ??
    BrowserWindow.getFocusedWindow() ??
    fullWindow ??
    undefined

  const dialogOptions: MessageBoxOptions = {
    type: 'warning',
    title: 'Stella Security Confirmation',
    message,
    detail,
    buttons: ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    checkboxLabel: 'Remember this decision on this device',
    checkboxChecked: true,
  }

  const choice = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)

  if (choice.response !== 0) {
    return false
  }

  if (choice.checkboxChecked) {
    trustedPrivilegedActions.add(key)
    await persistSecurityPolicy()
  }

  return true
}

const asTrimmedString = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const sanitizeOptionalHttpUrl = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!normalized) {
    return undefined
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`Invalid ${fieldName}.`)
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Invalid ${fieldName}.`)
  }

  return parsed.toString()
}

const sanitizeStoreId = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!STORE_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${fieldName}.`)
  }
  return normalized
}

const sanitizeStoreName = (value: unknown, fieldName: string) => {
  const normalized = asTrimmedString(value)
  if (!normalized || normalized.length > MAX_STORE_NAME_CHARS) {
    throw new Error(`Invalid ${fieldName}.`)
  }
  return normalized
}

const sanitizeStoreTokenList = (
  value: unknown,
  fieldName: string,
  maxItems: number,
) => {
  if (!Array.isArray(value)) {
    return [] as string[]
  }
  if (value.length > maxItems) {
    throw new Error(`Too many values for ${fieldName}.`)
  }
  const result: string[] = []
  for (const item of value) {
    const normalized = asTrimmedString(item)
    if (!STORE_TOKEN_PATTERN.test(normalized)) {
      throw new Error(`Invalid ${fieldName}.`)
    }
    result.push(normalized)
  }
  return result
}

const sanitizeThemePalette = (value: unknown, fieldName: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName} palette.`)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_THEME_TOKENS) {
    throw new Error(`Invalid ${fieldName} palette.`)
  }
  const palette: Record<string, string> = {}
  for (const [key, rawValue] of entries) {
    const normalizedKey = key.trim()
    const normalizedValue = asTrimmedString(rawValue)
    if (!STORE_TOKEN_PATTERN.test(normalizedKey) || !normalizedValue || normalizedValue.length > 200) {
      throw new Error(`Invalid ${fieldName} palette.`)
    }
    palette[normalizedKey] = normalizedValue
  }
  return palette
}

const sanitizeCanvasDependencies = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid canvas dependencies.')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_STORE_DEPENDENCIES) {
    throw new Error('Too many canvas dependencies.')
  }
  const dependencies: Record<string, string> = {}
  for (const [pkgName, rawVersion] of entries) {
    const version = asTrimmedString(rawVersion)
    if (!NPM_PACKAGE_NAME_PATTERN.test(pkgName) || !NPM_PACKAGE_VERSION_PATTERN.test(version)) {
      throw new Error('Invalid canvas dependencies.')
    }
    dependencies[pkgName] = version
  }
  return dependencies
}

const sanitizeCanvasSource = (value: unknown) => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid canvas source.')
  }
  if (value.length > MAX_STORE_SOURCE_CHARS) {
    throw new Error('Canvas source is too large.')
  }
  return value
}

const sanitizeStoreType = (value: unknown) => {
  if (typeof value !== 'string' || !STORE_PACKAGE_TYPES.has(value as 'skill' | 'theme' | 'canvas' | 'mod')) {
    throw new Error('Invalid package type.')
  }
  return value as 'skill' | 'theme' | 'canvas' | 'mod'
}

const sanitizeSkillInstallPayload = (payload: {
  packageId: string
  skillId: string
  name: string
  markdown: string
  agentTypes?: string[]
  tags?: string[]
}) => {
  const markdown = asTrimmedString(payload.markdown)
  if (!markdown) {
    throw new Error('Skill install requires markdown.')
  }
  if (markdown.length > MAX_STORE_MARKDOWN_CHARS) {
    throw new Error('Skill markdown is too large.')
  }
  const agentTypes = sanitizeStoreTokenList(payload.agentTypes, 'agentTypes', 16)
  return {
    packageId: sanitizeStoreId(payload.packageId, 'packageId'),
    skillId: sanitizeStoreId(payload.skillId, 'skillId'),
    name: sanitizeStoreName(payload.name, 'name'),
    markdown,
    agentTypes: agentTypes.length > 0 ? agentTypes : ['general'],
    tags: sanitizeStoreTokenList(payload.tags, 'tags', 32),
  }
}

const sanitizeThemeInstallPayload = (payload: {
  packageId: string
  themeId: string
  name: string
  light: Record<string, string>
  dark: Record<string, string>
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  themeId: sanitizeStoreId(payload.themeId, 'themeId'),
  name: sanitizeStoreName(payload.name, 'name'),
  light: sanitizeThemePalette(payload.light, 'light'),
  dark: sanitizeThemePalette(payload.dark, 'dark'),
})

const sanitizeCanvasInstallPayload = (payload: {
  packageId: string
  workspaceId?: string
  name: string
  dependencies?: Record<string, string>
  source?: string
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  workspaceId: payload.workspaceId === undefined ? undefined : sanitizeStoreId(payload.workspaceId, 'workspaceId'),
  name: sanitizeStoreName(payload.name, 'name'),
  dependencies: sanitizeCanvasDependencies(payload.dependencies),
  source: sanitizeCanvasSource(payload.source),
})

const sanitizeStoreUninstallPayload = (payload: {
  packageId: string
  type: string
  localId: string
}) => ({
  packageId: sanitizeStoreId(payload.packageId, 'packageId'),
  type: sanitizeStoreType(payload.type),
  localId: sanitizeStoreId(payload.localId, 'localId'),
})

const AUTH_CALLBACK_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/

const isTrustedAuthCallbackUrl = (value: string) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol.toLowerCase() !== `${AUTH_PROTOCOL.toLowerCase()}:`) {
      return false
    }
    const host = parsed.hostname.trim().toLowerCase()
    if (host !== 'auth') {
      return false
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '') || '/'
    if (normalizedPath !== '/' && normalizedPath !== '/auth' && normalizedPath !== '/callback') {
      return false
    }
    const token = parsed.searchParams.get('ott')
    return Boolean(token && AUTH_CALLBACK_TOKEN_PATTERN.test(token))
  } catch {
    return false
  }
}

const setupExternalLinkHandlers = (window: BrowserWindow) => {
  // Intercept target="_blank" / window.open and delegate safe external links.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) {
      if (!openSafeExternalUrl(url)) {
        console.warn(`[security] Blocked unsafe external navigation request: ${url}`)
      }
    }
    return { action: 'deny' }
  })

  // Prevent in-app navigation to external URLs
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      if (!openSafeExternalUrl(url)) {
        console.warn(`[security] Blocked unsafe external in-app navigation: ${url}`)
      }
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
      partition: STELLA_SESSION_PARTITION,
    },
  })

  setupExternalLinkHandlers(fullWindow)
  loadWindow(fullWindow, 'full')
  if (isDev) {
    fullWindow.webContents.openDevTools()
  }

  // Crash recovery: load static recovery page if renderer process crashes
  fullWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details.reason)
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.loadFile(path.join(__dirname, 'recovery.html'))
    }
  })

  fullWindow.on('closed', () => {
    fullWindow = null
  })
}

const positionMiniWindow = () => {
  if (!miniWindow) {
    return
  }

  // Place to the right of the mouse cursor
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const wa = display.workArea
  const GAP = 16

  let targetX = cursor.x + GAP
  // Vertically offset so the top third of the window aligns with the cursor
  let targetY = cursor.y - Math.round(miniSize.height / 3)

  // If the window would overflow the right edge, place it to the left of the cursor
  if (targetX + miniSize.width > wa.x + wa.width) {
    targetX = cursor.x - miniSize.width - GAP
  }

  // Clamp to work area bounds
  targetX = Math.max(wa.x, Math.min(targetX, wa.x + wa.width - miniSize.width))
  targetY = Math.max(wa.y, Math.min(targetY, wa.y + wa.height - miniSize.height))

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
      partition: STELLA_SESSION_PARTITION,
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
    // Mini shell no longer auto-hides on blur.
    // It is dismissed via the radial dial (selecting "chat" again).
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

const resetRegionCapture = () => {
  pendingRegionCaptureResolve = null
  pendingRegionCapturePromise = null
  hideRegionCaptureWindow()
}

const startRegionCapture = async () => {
  if (pendingRegionCapturePromise) {
    return pendingRegionCapturePromise
  }

  await showRegionCaptureWindow(cancelRegionCapture)

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

    // Convert overlay-relative selection to global DIP coordinates
    const regionBounds = getRegionCaptureWindow()?.getBounds()
    const globalX = (regionBounds?.x ?? 0) + selection.x
    const globalY = (regionBounds?.y ?? 0) + selection.y
    const centerX = globalX + selection.width / 2
    const centerY = globalY + selection.height / 2

    const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY })

    // Make selection coordinates relative to the target display
    const displayRelativeSelection = {
      x: globalX - display.bounds.x,
      y: globalY - display.bounds.y,
      width: selection.width,
      height: selection.height,
    }

    screenshot = await captureRegionScreenshot(display, displayRelativeSelection)
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
        if (pendingChatContext.regionScreenshots?.length) {
          setPendingChatContext({
            ...emptyContext(),
            regionScreenshots: pendingChatContext.regionScreenshots,
          })
        } else {
          setPendingChatContext(null)
        }
      }
      break
    case 'capture': {
      radialContextShouldCommit = true
      commitStagedRadialContext()
      // Lock context for capture mode so a late radial text/window probe does not
      // overwrite the final "window under mouse" metadata from region capture.
      cancelRadialContextCapture()
      updateUiState({ mode: 'chat' })
      // Hide radial + modifier overlay before entering region capture so they
      // don't appear in the screenshot (desktopCapturer captures composited screen).
      hideRadialWindow()
      hideModifierOverlay()
      const miniWasConcealed = concealMiniWindowForCapture()
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
      if (isMiniShowing()) {
        hideMiniWindow(true)
      } else {
        radialContextShouldCommit = true
        commitStagedRadialContext()
        updateUiState({ mode: 'chat' })
        showWindow('mini')
      }
      break
    }
    case 'voice':
      // No-op for now — voice UI will be rebuilt
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
      // Clear transient context (window, text) but preserve accumulated screenshots.
      if (!isMiniShowing() && !pendingMiniShowTimer && !pendingRadialCapturePromise) {
        if (pendingChatContext?.regionScreenshots?.length) {
          setPendingChatContext({
            ...emptyContext(),
            regionScreenshots: pendingChatContext.regionScreenshots,
          })
        } else {
          setPendingChatContext(null)
        }
      }
      if (process.platform === 'darwin') {
        // Hide preemptive overlay when modifier is released (unless radial is
        // active Ã¢â‚¬â€ onRadialHide will handle cleanup in that case).
        if (!mouseHook?.isRadialActive()) {
          hideModifierOverlay()
        }
      }
    },
    onLeftClick: () => {
      // Mini shell no longer auto-hides on external click.
      // It is dismissed via the radial dial (selecting "chat" again).
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
          if (pendingChatContext.regionScreenshots?.length) {
            setPendingChatContext({
              ...emptyContext(),
              regionScreenshots: pendingChatContext.regionScreenshots,
            })
          } else {
            setPendingChatContext(null)
          }
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

const deriveConvexSiteUrl = (convexUrl: string | null, explicitSiteUrl?: string | null) => {
  const explicit = explicitSiteUrl?.trim()
  if (explicit) {
    return explicit
  }
  const source = convexUrl?.trim()
  if (!source) {
    return null
  }
  if (source.includes('.convex.site')) {
    return source
  }
  if (source.includes('.convex.cloud')) {
    return source.replace('.convex.cloud', '.convex.site')
  }
  return null
}

const parseTokenResponse = async (response: Response): Promise<string | null> => {
  try {
    const payload = (await response.json()) as unknown
    if (!payload || typeof payload !== 'object') {
      return null
    }
    const record = payload as { token?: unknown; data?: { token?: unknown } }
    const nestedToken = record.data?.token
    if (typeof nestedToken === 'string' && nestedToken.trim()) {
      return nestedToken
    }
    if (typeof record.token === 'string' && record.token.trim()) {
      return record.token
    }
    return null
  } catch {
    return null
  }
}

const fetchRunnerAuthToken = async (): Promise<string | null> => {
  const convexSiteUrl = deriveConvexSiteUrl(pendingConvexUrl, pendingConvexSiteUrl)
  if (!convexSiteUrl) {
    return null
  }

  const tokenUrl = new URL('/api/auth/convex/token', convexSiteUrl).toString()
  try {
    const appSession = session.fromPartition(STELLA_SESSION_PARTITION)
    const cookies = await appSession.cookies.get({ url: tokenUrl })
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    if (!cookieHeader) {
      return null
    }

    const response = await fetch(tokenUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: cookieHeader,
      },
    })
    if (!response.ok) {
      if (response.status !== 401 && response.status !== 403) {
        console.warn(`[auth] Failed to refresh runner token: ${response.status}`)
      }
      return null
    }
    return await parseTokenResponse(response)
  } catch (error) {
    console.warn('[auth] Failed to fetch runner token from session', error)
    return null
  }
}

const refreshRunnerAuthToken = async () => {
  if (!hostAuthAuthenticated) {
    localHostRunner?.setAuthToken(null)

    return
  }
  const token = await fetchRunnerAuthToken()
  // Only update if we actually got a token from cookies.
  // If null, the renderer's token (via auth:setState) is still valid — don't clear it.
  if (token) {
    localHostRunner?.setAuthToken(token)
  }
}

const stopAuthRefreshLoop = () => {
  if (authRefreshTimer) {
    clearInterval(authRefreshTimer)
    authRefreshTimer = null
  }
  localHostRunner?.setAuthToken(null)

}

const startAuthRefreshLoop = () => {
  if (authRefreshTimer) {
    return
  }
  void refreshRunnerAuthToken()
  authRefreshTimer = setInterval(() => {
    void refreshRunnerAuthToken()
  }, TOKEN_REFRESH_INTERVAL_MS)
}

const setHostAuthState = (authenticated: boolean, token?: string) => {
  console.log('[auth] setHostAuthState called', {
    authenticated,
    hasToken: !!token,
    tokenLength: token?.length ?? 0,
    hasRunner: !!localHostRunner,
  })
  hostAuthAuthenticated = authenticated
  if (!authenticated) {
    stopAuthRefreshLoop()
    return
  }

  // If the renderer provided a Convex JWT directly, use it immediately.
  // This bypasses the cookie-based fetch which fails with BetterAuth crossDomain
  // (sessions are in localStorage, not cookies).
  if (token) {
    localHostRunner?.setAuthToken(token)
  }

  // Still start the refresh loop as a fallback (it will no-op if cookies aren't available,
  // but the renderer will keep pushing fresh tokens via auth:setState).
  startAuthRefreshLoop()
}

const configureLocalHost = (config: { convexUrl: string; convexSiteUrl?: string }) => {
  const convexUrl = config.convexUrl
  pendingConvexUrl = convexUrl
  pendingConvexSiteUrl = config.convexSiteUrl ?? null
  if (localHostRunner) {
    localHostRunner.setConvexUrl(convexUrl)
  }

  if (hostAuthAuthenticated) {
    void refreshRunnerAuthToken()
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
  securityPolicyPath = path.join(StellaHome.statePath, 'security_policy.json')
  await loadSecurityPolicy()
  const deviceIdentity = await getOrCreateDeviceIdentity(StellaHome.statePath)
  deviceId = deviceIdentity.deviceId
  localHostRunner = createLocalHostRunner({
    deviceId,
    StellaHome: StellaHome.homePath,
    frontendRoot: path.resolve(__dirname, '..'),
    requestCredential,
    signHeartbeatPayload: async (signedAtMs: number) => ({
      publicKey: deviceIdentity.publicKey,
      signature: signDeviceHeartbeat(deviceIdentity, signedAtMs),
    }),
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

  let currentVoiceShortcut = 'CommandOrControl+Shift+V'

  ipcMain.on('voice:setShortcut', (_event, shortcut: string) => {
    globalShortcut.unregister(currentVoiceShortcut)
    currentVoiceShortcut = shortcut
    if (shortcut) {
      globalShortcut.register(shortcut, () => {
        if (!appReady) return
        uiState.isVoiceActive = !uiState.isVoiceActive
        if (uiState.isVoiceActive) {
          uiState.mode = 'voice'
          if (fullWindow && fullWindow.isVisible() && !fullWindow.isMinimized()) {
            fullWindow.focus()
          } else {
            showWindow('mini')
          }
        }
        broadcastUiState()
      })
    }
  })

  // Register Voice shortcut initially
  globalShortcut.register(currentVoiceShortcut, () => {
    if (!appReady) return

    // Toggle voice state
    uiState.isVoiceActive = !uiState.isVoiceActive
    if (uiState.isVoiceActive) {
      uiState.mode = 'voice'
      // Focus the appropriate visible window so VoiceOverlay picks up the state
      if (fullWindow && fullWindow.isVisible() && !fullWindow.isMinimized()) {
        fullWindow.focus()
      } else {
        showWindow('mini')
      }
    }
    broadcastUiState()
  })

  // ─── Wake Word Detection ──────────────────────────────────────────────
  {
    const { createWakeWordDetector } = await import('./wake-word/detector.js')
    const { createAudioCaptureManager } = await import('./wake-word/audio-capture.js')

    const modelsDir = isDev
      ? path.join(__dirname, '..', 'resources', 'models')
      : path.join(process.resourcesPath, 'models')

    try {
      const detector = await createWakeWordDetector(modelsDir)
      const capture = createAudioCaptureManager(detector, getVoiceWindow)

      capture.onDetection((result) => {
        if (!appReady) return
        console.log(`[WakeWord] Detected! score=${result.score.toFixed(3)} vad=${result.vadScore.toFixed(3)}`)

        // Activate realtime voice-to-voice mode
        uiState.isVoiceRtcActive = true
        uiState.mode = 'voice'
        // Focus the appropriate window so VoiceOverlay picks up the state
        if (fullWindow && fullWindow.isVisible() && !fullWindow.isMinimized()) {
          fullWindow.focus()
        } else {
          showWindow('mini')
        }
        broadcastUiState()

        // Pause wake word while voice is active
        capture.stop()
      })

      // Start wake word listening when app becomes ready
      ipcMain.on('app:setReady', () => {
        setTimeout(() => {
          if (!capture.isCapturing()) {
            capture.start()
            console.log('[WakeWord] Listening started')
          }
        }, 2000)
      })

      // Resume wake word when voice mode deactivates
      setInterval(() => {
        if (appReady && !uiState.isVoiceActive && !uiState.isVoiceRtcActive && !capture.isCapturing()) {
          capture.start()
        }
      }, 1000)

      console.log('[WakeWord] Detector initialized')
    } catch (err) {
      console.error('[WakeWord] Failed to initialize:', (err as Error).message)
    }
  }

  // ─── Voice-to-Voice (Realtime API) ──────────────────────────────────────────
  let currentVoiceRtcShortcut = 'CommandOrControl+Shift+D'

  const toggleVoiceRtc = () => {
    if (!appReady) return
    uiState.isVoiceRtcActive = !uiState.isVoiceRtcActive
    if (uiState.isVoiceRtcActive) {
      // Deactivate STT voice if it was on
      uiState.isVoiceActive = false
      // Focus the appropriate window so VoiceOverlay picks up the state
      if (fullWindow && fullWindow.isVisible() && !fullWindow.isMinimized()) {
        fullWindow.focus()
      } else {
        showWindow('mini')
      }
    }
    broadcastUiState()
  }

  globalShortcut.register(currentVoiceRtcShortcut, toggleVoiceRtc)

  ipcMain.on('voice-rtc:setShortcut', (_event, shortcut: string) => {
    globalShortcut.unregister(currentVoiceRtcShortcut)
    currentVoiceRtcShortcut = shortcut
    if (shortcut) {
      globalShortcut.register(shortcut, toggleVoiceRtc)
    }
  })

  // Voice-to-voice: delegate to the orchestrator via the local agent runtime
  ipcMain.handle('voice:orchestratorChat', async (_event, payload: { conversationId: string; message: string }) => {
    if (!localHostRunner) {
      return 'Error: Local host runner not initialized'
    }

    return new Promise<string>((resolve) => {
      let fullText = ''

      localHostRunner!.handleLocalChat(
        {
          conversationId: payload.conversationId,
          userMessageId: `voice-${Date.now()}`,
          agentType: 'orchestrator',
          storageMode: 'local',
          localHistory: [{ role: 'user', content: payload.message }],
        },
        {
          onStream: (ev) => {
            if (ev.chunk) fullText += ev.chunk
          },
          onToolStart: () => {},
          onToolEnd: () => {},
          onEnd: (ev) => {
            resolve(ev.finalText ?? fullText || 'Done.')
          },
          onError: (ev) => {
            resolve(`Error: ${ev.error ?? 'Unknown error'}`)
          },
        },
      ).catch((err) => {
        resolve(`Error: ${(err as Error).message}`)
      })
    })
  })

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
  ipcMain.handle('host:configure', (event, config: { convexUrl?: string; convexSiteUrl?: string }) => {
    if (!assertPrivilegedSender(event, 'host:configure')) {
      throw new Error('Blocked untrusted host configuration request.')
    }
    const convexUrl = sanitizeOptionalHttpUrl(config?.convexUrl, 'convexUrl')
    const convexSiteUrl = sanitizeOptionalHttpUrl(config?.convexSiteUrl, 'convexSiteUrl')
    if (convexUrl) {
      configureLocalHost({ convexUrl, convexSiteUrl })
    }
    return { deviceId }
  })
  ipcMain.handle('auth:setState', (_event, payload: { authenticated?: boolean; token?: string }) => {
    setHostAuthState(Boolean(payload?.authenticated), payload?.token)
    return { ok: true }
  })
  ipcMain.handle('app:hardResetLocalState', async (event) => {
    if (!assertPrivilegedSender(event, 'app:hardResetLocalState')) {
      throw new Error('Blocked untrusted local reset request.')
    }

    const hadRunner = Boolean(localHostRunner)

    if (localHostRunner) {
      localHostRunner.stop()
      localHostRunner = null
    }

    setHostAuthState(false)
    appReady = false
    pendingAuthCallback = null
    uiState.isVoiceActive = false

    if (pendingMiniChatContextAck) {
      clearTimeout(pendingMiniChatContextAck.timeout)
      pendingMiniChatContextAck.resolve()
      pendingMiniChatContextAck = null
    }
    setPendingChatContext(null)
    lastBroadcastChatContextVersion = -1
    lastMiniChatContextAckVersion = -1
    hideMiniWindow(false)

    trustedPrivilegedActions.clear()
    externalOpenRateBySender.clear()

    const appSession = session.fromPartition(STELLA_SESSION_PARTITION)
    await Promise.allSettled([
      appSession.clearStorageData(),
      appSession.clearCache(),
    ])

    const homePath = app.getPath('home')
    await Promise.allSettled([
      fs.rm(path.join(homePath, '.stella'), { recursive: true, force: true }),
      fs.rm(path.join(homePath, '.Stella'), { recursive: true, force: true }),
    ])

    if (hadRunner) {
      const StellaHome = await resolveStellaHome(app)
      StellaHomePath = StellaHome.homePath
      securityPolicyPath = path.join(StellaHome.statePath, 'security_policy.json')
      await loadSecurityPolicy()
      const deviceIdentity = await getOrCreateDeviceIdentity(StellaHome.statePath)
      deviceId = deviceIdentity.deviceId

      localHostRunner = createLocalHostRunner({
        deviceId,
        StellaHome: StellaHome.homePath,
        frontendRoot: path.resolve(__dirname, '..'),
        requestCredential,
        signHeartbeatPayload: async (signedAtMs: number) => ({
          publicKey: deviceIdentity.publicKey,
          signature: signDeviceHeartbeat(deviceIdentity, signedAtMs),
        }),
      })
      if (pendingConvexUrl) {
        localHostRunner.setConvexUrl(pendingConvexUrl)
      }
      localHostRunner.start()
    }

    broadcastUiState()
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
    const { window: nextWindow, isVoiceActive, isVoiceRtcActive, ...rest } = partial
    if (nextWindow) {
      showWindow(nextWindow)
    }
    if (isVoiceActive !== undefined) {
      uiState.isVoiceActive = isVoiceActive
    }
    if (isVoiceRtcActive !== undefined) {
      uiState.isVoiceRtcActive = isVoiceRtcActive
    }
    if (Object.keys(rest).length > 0) {
      updateUiState(rest)
    }
    if (isVoiceActive !== undefined || isVoiceRtcActive !== undefined) {
      broadcastUiState()
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
    broadcastChatContext()
  })

  ipcMain.on('region:select', (_event, selection: RegionSelection) => {
    void finalizeRegionCapture(selection)
  })

  ipcMain.on('region:cancel', () => {
    cancelRegionCapture()
  })

  ipcMain.on('voice:transcript', (_event, transcript: string) => {
    // Forward transcript to the active windows (mini or full)
    for (const win of BrowserWindow.getAllWindows()) {
      if (win === miniWindow || win === fullWindow) {
        win.webContents.send('voice:transcript', transcript)
      }
    }
  })

  ipcMain.handle('region:getWindowCapture', async (_event, point: { x: number; y: number }) => {
    const regionBounds = getRegionCaptureWindow()?.getBounds()
    if (!regionBounds) return null

    const dipX = regionBounds.x + point.x
    const dipY = regionBounds.y + point.y
    const clickDisplay = screen.getDisplayNearestPoint({ x: dipX, y: dipY })
    const scaleFactor = process.platform === 'darwin' ? 1 : (clickDisplay.scaleFactor ?? 1)
    const screenX = Math.round(dipX * scaleFactor)
    const screenY = Math.round(dipY * scaleFactor)

    const capture = await captureWindowScreenshot(screenX, screenY, { excludePids: [process.pid] })
    if (!capture) return null

    const { bounds } = capture.windowInfo
    return {
      bounds: {
        x: Math.round(bounds.x / scaleFactor) - regionBounds.x,
        y: Math.round(bounds.y / scaleFactor) - regionBounds.y,
        width: Math.round(bounds.width / scaleFactor),
        height: Math.round(bounds.height / scaleFactor),
      },
      thumbnail: capture.screenshot.dataUrl,
    }
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

    let capture: Awaited<ReturnType<typeof captureWindowScreenshot>> = null
    try {
      // Wait briefly for composited overlays to disappear before capture.
      await new Promise((r) => setTimeout(r, CAPTURE_OVERLAY_HIDE_DELAY_MS))

      // Convert overlay-local click coordinates into global desktop coordinates.
      // regionWindow bounds are DIP; the native picker expects global coordinates.
      const regionBounds = getRegionCaptureWindow()?.getBounds()
      let capturePoint = { x: point.x, y: point.y }
      if (regionBounds) {
        const dipX = regionBounds.x + point.x
        const dipY = regionBounds.y + point.y
        const clickDisplay = screen.getDisplayNearestPoint({ x: dipX, y: dipY })
        const scaleFactor = process.platform === 'darwin' ? 1 : (clickDisplay.scaleFactor ?? 1)
        capturePoint = {
          x: Math.round(dipX * scaleFactor),
          y: Math.round(dipY * scaleFactor),
        }
      }

      // Capture window at clicked point using native screenshot.
      capture = await captureWindowScreenshot(
        capturePoint.x,
        capturePoint.y,
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

  ipcMain.handle('browserData:detectPreferredBrowser', async () => {
    return detectPreferredBrowserProfile()
  })

  ipcMain.handle('browserData:listProfiles', async (_event, browserType: string) => {
    return listBrowserProfiles(browserType as BrowserType)
  })

  ipcMain.handle('workspace:listPanels', async () => {
    return listWorkspacePanels()
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
  ipcMain.on('shell:openExternal', (event, url: string) => {
    if (!assertPrivilegedSender(event, 'shell:openExternal')) {
      return
    }
    const safeUrl = normalizeExternalHttpUrl(url)
    if (!safeUrl) {
      console.warn('[security] Blocked unsafe shell:openExternal request.')
      return
    }
    if (!consumeExternalOpenBudget(event.sender.id)) {
      console.warn('[security] Throttled shell:openExternal request from renderer.')
      return
    }
    void shell.openExternal(safeUrl)
  })

  // Open Full Disk Access in System Preferences (macOS)
  ipcMain.on('system:openFullDiskAccess', async (event) => {
    if (!assertPrivilegedSender(event, 'system:openFullDiskAccess')) {
      return
    }
    const approved = await ensurePrivilegedActionApproval(
      'system.open_full_disk_access',
      'Allow Stella to open Full Disk Access settings?',
      'This opens macOS System Settings so Stella can be granted disk access for user-requested tasks.',
      event,
    )
    if (!approved) {
      return
    }
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

  ipcMain.handle('store:installSkill', async (event, payload: {
    packageId: string; skillId: string; name: string; markdown: string; agentTypes?: string[]; tags?: string[]
  }) => {
    if (!assertPrivilegedSender(event, 'store:installSkill')) {
      throw new Error('Blocked untrusted store install request.')
    }
    const safePayload = sanitizeSkillInstallPayload(payload)
    const approved = await ensurePrivilegedActionApproval(
      'store.install.skill',
      'Allow Stella to install a skill package?',
      'Skills write files under ~/.stella/skills. This keeps Stella autonomous while preventing hidden renderer abuse.',
      event,
    )
    if (!approved) {
      throw new Error('Skill install denied.')
    }
    return unwrapStoreResult(await handleInstallSkill(safePayload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:installTheme', async (event, payload: {
    packageId: string; themeId: string; name: string; light: Record<string, string>; dark: Record<string, string>
  }) => {
    if (!assertPrivilegedSender(event, 'store:installTheme')) {
      throw new Error('Blocked untrusted store theme install request.')
    }
    const safePayload = sanitizeThemeInstallPayload(payload)
    const approved = await ensurePrivilegedActionApproval(
      'store.install.theme',
      'Allow Stella to install a theme package?',
      'Themes write files under ~/.stella/themes.',
      event,
    )
    if (!approved) {
      throw new Error('Theme install denied.')
    }
    return unwrapStoreResult(await handleInstallTheme(safePayload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:installCanvas', async (event, payload: {
    packageId: string
    workspaceId?: string
    name: string
    dependencies?: Record<string, string>
    source?: string
  }) => {
    if (!assertPrivilegedSender(event, 'store:installCanvas')) {
      throw new Error('Blocked untrusted store canvas install request.')
    }
    const safePayload = sanitizeCanvasInstallPayload(payload)
    const approved = await ensurePrivilegedActionApproval(
      'store.install.canvas',
      'Allow Stella to install a canvas app?',
      'Canvas installs can write local app code and dependencies under ~/.stella/apps.',
      event,
    )
    if (!approved) {
      throw new Error('Canvas install denied.')
    }
    return unwrapStoreResult(await handleInstallCanvas(safePayload as unknown as Record<string, unknown>))
  })

  ipcMain.handle('store:uninstall', async (event, payload: {
    packageId: string; type: string; localId: string
  }) => {
    if (!assertPrivilegedSender(event, 'store:uninstall')) {
      throw new Error('Blocked untrusted store uninstall request.')
    }
    const safePayload = sanitizeStoreUninstallPayload(payload)
    const approved = await ensurePrivilegedActionApproval(
      'store.uninstall',
      'Allow Stella to uninstall local package files?',
      'Uninstall may remove files under ~/.stella.',
      event,
    )
    if (!approved) {
      throw new Error('Package uninstall denied.')
    }
    return unwrapStoreResult(await handleUninstallPackage(safePayload as unknown as Record<string, unknown>))
  })

  // Bridge manager IPC handlers
  ipcMain.handle('bridge:deploy', async (event, payload: {
    provider: string; code: string; env: Record<string, string>; dependencies: string
  }) => {
    if (!assertPrivilegedSender(event, 'bridge:deploy')) {
      throw new Error('Blocked untrusted bridge deploy request.')
    }
    const approved = await ensurePrivilegedActionApproval(
      'bridge.deploy',
      'Allow Stella to deploy local bridge code?',
      'Bridge deploy writes executable code under ~/.stella/bridges and may install dependencies.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge deploy denied.')
    }
    return bridgeManager.deploy(payload)
  })

  ipcMain.handle('bridge:start', async (event, payload: { provider: string }) => {
    if (!assertPrivilegedSender(event, 'bridge:start')) {
      throw new Error('Blocked untrusted bridge start request.')
    }
    const approved = await ensurePrivilegedActionApproval(
      'bridge.start',
      'Allow Stella to start local bridge processes?',
      'Starting a bridge runs local Node.js code with configured bridge environment variables.',
      event,
    )
    if (!approved) {
      throw new Error('Bridge start denied.')
    }
    return bridgeManager.start(payload.provider)
  })

  ipcMain.handle('bridge:stop', async (event, payload: { provider: string }) => {
    if (!assertPrivilegedSender(event, 'bridge:stop')) {
      throw new Error('Blocked untrusted bridge stop request.')
    }
    return bridgeManager.stop(payload.provider)
  })

  ipcMain.handle('bridge:status', async (_event, payload: { provider: string }) => {
    return { running: bridgeManager.isRunning(payload.provider) }
  })

  ipcMain.handle('shell:killByPort', async (event, payload: { port: number }) => {
    if (!assertPrivilegedSender(event, 'shell:killByPort')) {
      throw new Error('Blocked untrusted shell kill request.')
    }
    const port = Number(payload?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid port.')
    }
    if (localHostRunner) {
      localHostRunner.killShellsByPort(port)
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

  // ─── Local Agent Runtime IPC ──────────────────────────────────────────────

  type AgentEventPayload = {
    type: 'stream' | 'tool-start' | 'tool-end' | 'error' | 'end'
    runId: string
    seq: number
    chunk?: string
    toolCallId?: string
    toolName?: string
    resultPreview?: string
    error?: string
    fatal?: boolean
    finalText?: string
    persisted?: boolean
  }

  const AGENT_EVENT_BUFFER_LIMIT = 1000
  const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1000

  const agentRunOwners = new Map<string, number>()
  const agentEventBuffers = new Map<
    string,
    {
      events: AgentEventPayload[]
      updatedAt: number
    }
  >()

  function pruneAgentEventBuffers() {
    const now = Date.now()
    for (const [runId, buffer] of agentEventBuffers.entries()) {
      if (agentRunOwners.has(runId)) continue
      if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
        agentEventBuffers.delete(runId)
      }
    }
  }

  function bufferAgentEvent(runId: string, event: AgentEventPayload) {
    const existing = agentEventBuffers.get(runId)
    if (existing) {
      existing.events.push(event)
      if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
        existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT)
      }
      existing.updatedAt = Date.now()
      return
    }

    agentEventBuffers.set(runId, {
      events: [event],
      updatedAt: Date.now(),
    })
  }

  function emitAgentEvent(runId: string, event: AgentEventPayload, targetWebContentsId?: number) {
    bufferAgentEvent(runId, event)
    pruneAgentEventBuffers()
    const receiverId = targetWebContentsId ?? agentRunOwners.get(runId)
    if (receiverId == null) {
      return
    }
    const receiver = webContents.fromId(receiverId)
    if (receiver && !receiver.isDestroyed()) {
      receiver.send('agent:event', event)
    }
  }

  ipcMain.handle('agent:healthCheck', async () => {
    if (!localHostRunner) {
      console.log('[agent:healthCheck] no runner')
      return null
    }
    const result = localHostRunner.agentHealthCheck()
    if (result) {
      console.log('[agent:healthCheck]', result)
    }
    return result
  })

  ipcMain.handle('agent:getActiveRun', async () => {
    if (!localHostRunner) return null
    const health = localHostRunner.agentHealthCheck()
    if (!health?.ready) return null
    return localHostRunner.getActiveOrchestratorRun()
  })

  ipcMain.handle('agent:resume', async (_event, payload: { runId: string; lastSeq: number }) => {
    pruneAgentEventBuffers()
    const runId = typeof payload.runId === 'string' ? payload.runId : ''
    const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0
    if (!runId) {
      return { events: [] as AgentEventPayload[], exhausted: true }
    }
    const buffer = agentEventBuffers.get(runId)
    if (!buffer) {
      return { events: [] as AgentEventPayload[], exhausted: true }
    }
    const oldestSeq = buffer.events[0]?.seq ?? null
    const exhausted = oldestSeq !== null && lastSeq < oldestSeq - 1
    return {
      events: buffer.events.filter((event) => event.seq > lastSeq),
      exhausted,
    }
  })

  ipcMain.handle('agent:startChat', async (_event, payload: {
    conversationId: string
    userMessageId: string
    agentType?: string
    storageMode?: 'cloud' | 'local'
    localHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  }) => {
    console.log('[agent:startChat] received', {
      hasRunner: !!localHostRunner,
      conversationId: payload.conversationId,
      storageMode: payload.storageMode,
    })
    if (!localHostRunner) {
      throw new Error('Local host runner not available')
    }

    const healthCheck = localHostRunner.agentHealthCheck()
    console.log('[agent:startChat] healthCheck =', healthCheck)
    if (!healthCheck?.ready) {
      throw new Error('Agent runtime not ready')
    }

    const senderWebContentsId = _event.sender.id
    const result = await localHostRunner.handleLocalChat(payload, {
      onStream: (ev) => emitAgentEvent(ev.runId, { type: 'stream', ...ev }, senderWebContentsId),
      onToolStart: (ev) => emitAgentEvent(ev.runId, { type: 'tool-start', ...ev }, senderWebContentsId),
      onToolEnd: (ev) => emitAgentEvent(ev.runId, { type: 'tool-end', ...ev }, senderWebContentsId),
      onError: (ev) => emitAgentEvent(ev.runId, { type: 'error', ...ev }, senderWebContentsId),
      onEnd: (ev) => {
        emitAgentEvent(ev.runId, { type: 'end', ...ev }, senderWebContentsId)
        setTimeout(() => {
          agentRunOwners.delete(ev.runId)
          pruneAgentEventBuffers()
        }, 60_000)
      },
    })

    agentRunOwners.set(result.runId, senderWebContentsId)
    return result
  })

  ipcMain.on('agent:cancelChat', (_event, runId: string) => {
    if (localHostRunner && typeof runId === 'string') {
      localHostRunner.cancelLocalChat(runId)
      agentRunOwners.delete(runId)
    }
  })

  ipcMain.handle('selfmod:revert', async (_event, payload: { featureId: string; steps?: number }) => {
    if (!localHostRunner) {
      throw new Error('Local host runner not available')
    }
    // Import revert handler dynamically to avoid circular deps
    const { handleSelfModRevert } = await import('./local-host/tools_self_mod.js')
    const frontendRoot = path.join(__dirname, '..')
    const context = { conversationId: '', requestId: '', deviceId: '', agentType: 'user' }
    return handleSelfModRevert(
      { feature_id: payload.featureId, steps: payload.steps },
      context,
      frontendRoot,
    )
  })

  ipcMain.handle('selfmod:lastFeature', async () => {
    if (!localHostRunner) return null
    return localHostRunner.getLastAppliedFeatureId()
  })

  // App reload — used by recovery page to restart the full app after crash recovery
  ipcMain.on('app:reload', () => {
    if (fullWindow && !fullWindow.isDestroyed()) {
      loadWindow(fullWindow, 'full')
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
      const windowCapture = await captureWindowScreenshot(
        capturePoint.x,
        capturePoint.y,
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
  stopAuthRefreshLoop()
  if (localHostRunner) {
    localHostRunner.killAllShells()
  }
  bridgeManager.stopAll()
  cleanupSelectedTextProcess()
  destroyModifierOverlay()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
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
