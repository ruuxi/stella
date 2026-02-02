import type { UiState, WindowMode } from './ui'

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

export type AllUserSignalsResult = {
  data: AllUserSignals | null
  formatted: string | null
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
  configureHost: (config: { convexUrl?: string }) => Promise<{ deviceId: string | null }>
  setAuthToken: (payload: { token: string | null }) => Promise<{ ok: boolean }>
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
  cancelRegionCapture: () => void
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
  writeCoreMemory: (content: string) => Promise<{ ok: boolean; error?: string }>
  // Comprehensive user signal collection (browser + dev projects + shell + apps)
  collectAllSignals: () => Promise<AllUserSignalsResult>
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}
