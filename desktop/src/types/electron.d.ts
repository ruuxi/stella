import type { UiState, WindowMode } from './ui'
import type { Theme } from '../theme/themes/types'

export type RadialWedge = 'capture' | 'chat' | 'full' | 'voice' | 'auto' | 'dismiss'

export type ChatContext = {
  window: {
    title: string
    app: string
    bounds: { x: number; y: number; width: number; height: number }
  } | null
  browserUrl?: string | null
  selectedText?: string | null
  regionScreenshots?: {
    dataUrl: string
    width: number
    height: number
  }[]
  capturePending?: boolean
}

export type ChatContextUpdate = {
  context: ChatContext | null
  version: number
}

// ---------------------------------------------------------------------------
// Browser Data Types
// ---------------------------------------------------------------------------

export type BrowserType = 'chrome' | 'edge' | 'brave' | 'arc' | 'opera' | 'vivaldi'

export type DomainVisit = {
  domain: string
  visits: number
}

export type DomainDetail = {
  title: string
  url: string
  visitCount: number
}

export type BrowserData = {
  browser: BrowserType | null
  clusterDomains: string[]
  recentDomains: DomainVisit[]
  allTimeDomains: DomainVisit[]
  domainDetails: Record<string, DomainDetail[]>
}

export type BrowserDataResult = {
  data: BrowserData | null
  formatted: string | null
  error?: string
}

export type PreferredBrowserProfile = {
  browser: BrowserType | null
  profile: string | null
}

export type BrowserProfile = {
  id: string       // e.g. "Default", "Profile 1"
  name: string     // display name, e.g. "Work", "Personal"
}

// ---------------------------------------------------------------------------
// Dev Projects Types
// ---------------------------------------------------------------------------

export type DevProject = {
  name: string
  path: string
  lastActivity: number // timestamp in ms
}

// ---------------------------------------------------------------------------
// Shell History Types
// ---------------------------------------------------------------------------

export type CommandFrequency = {
  command: string
  count: number
}

export type ShellAnalysis = {
  topCommands: CommandFrequency[]
  projectPaths: string[]
  toolsUsed: string[]
}

// ---------------------------------------------------------------------------
// App Discovery Types
// ---------------------------------------------------------------------------

export type DiscoveredApp = {
  name: string
  executablePath: string
  source: 'running' | 'recent'
  lastUsed?: number
}

// ---------------------------------------------------------------------------
// Combined User Signals Types
// ---------------------------------------------------------------------------

export type AllUserSignals = {
  browser: BrowserData
  devProjects: DevProject[]
  shell: ShellAnalysis
  apps: DiscoveredApp[]
}

export type DiscoveryCategory =
  | "browsing_bookmarks"
  | "dev_environment"
  | "apps_system"
  | "messages_notes"

export type AllUserSignalsResult = {
  data: AllUserSignals | null
  formatted: string | null
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null
  error?: string
}

export type ElectronApi = {
  platform: string
  
  // Window controls for custom title bar
  minimizeWindow: () => void
  maximizeWindow: () => void
  closeWindow: () => void
  isMaximized: () => Promise<boolean>
  
  getUiState: () => Promise<UiState>
  setUiState: (partial: Partial<UiState>) => Promise<UiState>
  onUiState: (callback: (state: UiState) => void) => () => void
  showWindow: (target: WindowMode) => void
  captureScreenshot: (point?: { x: number; y: number }) => Promise<{
    dataUrl: string
    width: number
    height: number
  } | null>
  getChatContext: () => Promise<ChatContext | null>
  onChatContext: (callback: (payload: ChatContext | null | ChatContextUpdate) => void) => () => void
  ackChatContext: (payload: { version: number }) => void
  onMiniVisibility: (callback: (visible: boolean) => void) => () => void
  onDismissPreview: (callback: () => void) => () => void
  getDeviceId: () => Promise<string | null>
  configureHost: (config: { convexUrl?: string; convexSiteUrl?: string }) => Promise<{ deviceId: string | null }>
  setAuthState: (payload: { authenticated: boolean }) => Promise<{ ok: boolean }>
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void
  // App readiness gate (controls radial menu + mini shell)
  setAppReady: (ready: boolean) => void
  // Radial dial events
  onRadialShow: (
    callback: (event: unknown, data: { centerX: number; centerY: number; x?: number; y?: number }) => void
  ) => () => void
  onRadialHide: (callback: () => void) => () => void
  onRadialCursor: (
    callback: (event: unknown, data: { x: number; y: number; centerX: number; centerY: number }) => void
  ) => () => void
  submitRegionSelection: (payload: { x: number; y: number; width: number; height: number }) => void
  submitRegionClick: (point: { x: number; y: number }) => void
  cancelRegionCapture: () => void
  removeScreenshot: (index: number) => void
  // Theme sync across windows
  onThemeChange: (callback: (event: unknown, data: { key: string; value: string }) => void) => () => void
  broadcastThemeChange: (key: string, value: string) => void
  onCredentialRequest: (
    callback: (
      event: unknown,
      data: { requestId: string; provider: string; label?: string; description?: string; placeholder?: string }
    ) => void
  ) => () => void
  submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) => Promise<{ ok: boolean; error?: string }>
  cancelCredential: (payload: { requestId: string }) => Promise<{ ok: boolean; error?: string }>
  // Browser data collection for core memory
  checkCoreMemoryExists: () => Promise<boolean>
  collectBrowserData: () => Promise<BrowserDataResult>
  detectPreferredBrowser: () => Promise<PreferredBrowserProfile>
  listBrowserProfiles: (browserType: string) => Promise<BrowserProfile[]>
  writeCoreMemory: (content: string) => Promise<{ ok: boolean; error?: string }>
  // Comprehensive user signal collection (browser + dev projects + shell + apps)
  collectAllSignals: (options?: { categories?: string[] }) => Promise<AllUserSignalsResult>
  // Identity map for pseudonymization
  getIdentityMap: () => Promise<{ version: number; mappings: { real: { name: string; identifier: string }; alias: { name: string; identifier: string }; source: string }[] }>
  depseudonymize: (text: string) => Promise<string>
  // System preferences (macOS FDA)
  openFullDiskAccess: () => void
  // Open URL in user's default browser
  openExternal: (url: string) => void

  // Store package management
  storeInstallSkill: (payload: {
    packageId: string
    skillId: string
    name: string
    markdown: string
    agentTypes?: string[]
    tags?: string[]
  }) => Promise<{ installed: boolean; path?: string }>
  storeInstallTheme: (payload: {
    packageId: string
    themeId: string
    name: string
    light: Record<string, string>
    dark: Record<string, string>
  }) => Promise<{ installed: boolean; themeId?: string }>
  storeInstallCanvas: (payload: {
    packageId: string
    workspaceId?: string
    name: string
    dependencies?: Record<string, string>
    source?: string
  }) => Promise<{ installed: boolean; workspaceId?: string; path?: string }>
  storeUninstall: (payload: {
    packageId: string
    type: string
    localId: string
  }) => Promise<{ uninstalled: boolean; requiresRevert?: boolean; note?: string }>

  // Theme loading from installed themes
  listInstalledThemes: () => Promise<Theme[]>

  // Bridge manager
  bridgeDeploy: (payload: {
    provider: string; code: string; env: Record<string, string>; dependencies: string
  }) => Promise<{ ok: boolean; error?: string }>
  bridgeStart: (payload: { provider: string }) => Promise<{ ok: boolean; error?: string }>
  bridgeStop: (payload: { provider: string }) => Promise<{ ok: boolean }>
  bridgeStatus: (payload: { provider: string }) => Promise<{ running: boolean }>

  shellKillByPort: (port: number) => Promise<void>
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
