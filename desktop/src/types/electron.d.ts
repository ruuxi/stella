import type { UiState, WindowMode } from './ui'
import type { Theme } from '@/theme/themes/types'
import type { AgentStreamEvent } from '@/hooks/streaming/streaming-types'
import type { DiscoveryCategory } from '@/app/onboarding/use-onboarding-state'

export type RadialWedge = 'capture' | 'chat' | 'full' | 'voice' | 'auto' | 'dismiss'

/** Must stay in sync with electron/chat-context.ts (source of truth). */
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

export type MiniBridgeEventRecord = {
  _id: string
  timestamp: number
  type: string
  deviceId?: string
  requestId?: string
  targetDeviceId?: string
  payload?: Record<string, unknown>
  channelEnvelope?: Record<string, unknown>
}

export type MiniBridgeSnapshot = {
  conversationId: string | null
  events: MiniBridgeEventRecord[]
  streamingText: string
  reasoningText: string
  isStreaming: boolean
  pendingUserMessageId: string | null
}

export type MiniBridgeRequest =
  | {
      type: 'query:snapshot'
      conversationId: string | null
    }
  | {
      type: 'mutation:sendMessage'
      conversationId: string
      text: string
      selectedText: string | null
      chatContext: ChatContext | null
    }

export type MiniBridgeResponse =
  | {
      type: 'query:snapshot'
      snapshot: MiniBridgeSnapshot
    }
  | {
      type: 'mutation:sendMessage'
      accepted: boolean
    }
  | {
      type: 'error'
      message: string
    }

export type MiniBridgeRequestEnvelope = {
  requestId: string
  request: MiniBridgeRequest
}

export type MiniBridgeResponseEnvelope = {
  requestId: string
  response: MiniBridgeResponse
}

export type MiniBridgeUpdate = {
  type: 'snapshot'
  snapshot: MiniBridgeSnapshot
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

export type { DiscoveryCategory } from '@/app/onboarding/use-onboarding-state'

export type AllUserSignalsResult = {
  data: AllUserSignals | null
  formatted: string | null
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null
  error?: string
}

// ---------------------------------------------------------------------------
// Agent Types
// ---------------------------------------------------------------------------

export type AgentStreamIpcEvent = AgentStreamEvent

export type SelfModFeatureSummary = {
  featureId: string
  name: string
  description: string
  latestCommit: string
  latestTimestampMs: number
  commitCount: number
  tainted?: boolean
  taintedFiles?: string[]
}

export type AgentHealth =
  | {
      ready: true
      runnerVersion?: string
      engine?: string
    }
  | {
      ready: false
      reason?: string
      engine?: string
    }

export type LocalLlmCredentialSummary = {
  provider: string
  label: string
  status: 'active'
  updatedAt: number
}

export type LocalCronSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string }

export type LocalCronPayload =
  | { kind: 'systemEvent'; text: string; agentType?: string; deliver?: boolean }
  | { kind: 'agentTurn'; message: string; agentType?: string; deliver?: boolean }

export type LocalHeartbeatActiveHours = {
  start: string
  end: string
  timezone?: string
}

export type LocalCronJobRecord = {
  id: string
  conversationId: string
  name: string
  description?: string
  enabled: boolean
  schedule: LocalCronSchedule
  sessionTarget: 'main' | 'isolated'
  payload: LocalCronPayload
  deleteAfterRun?: boolean
  nextRunAtMs: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: string
  lastError?: string
  lastDurationMs?: number
  lastOutputPreview?: string
  createdAt: number
  updatedAt: number
}

export type LocalHeartbeatConfigRecord = {
  id: string
  conversationId: string
  enabled: boolean
  intervalMs: number
  prompt?: string
  checklist?: string
  ackMaxChars?: number
  deliver?: boolean
  agentType?: string
  activeHours?: LocalHeartbeatActiveHours
  targetDeviceId?: string
  runningAtMs?: number
  lastRunAtMs?: number
  nextRunAtMs: number
  lastStatus?: string
  lastError?: string
  lastSentText?: string
  lastSentAtMs?: number
  createdAt: number
  updatedAt: number
}

export type ScheduledConversationEvent = {
  _id: string
  conversationId: string
  timestamp: number
  type: 'assistant_message'
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Namespaced API sub-types
// ---------------------------------------------------------------------------

export type ElectronWindowApi = {
  minimize: () => void
  maximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
  show: (target: WindowMode) => void
}

export type ElectronUiApi = {
  getState: () => Promise<UiState>
  setState: (partial: Partial<UiState>) => Promise<UiState>
  onState: (callback: (state: UiState) => void) => () => void
  setAppReady: (ready: boolean) => void
  reload: () => void
  hardReset: () => Promise<{ ok: boolean }>
}

export type ElectronCaptureApi = {
  getContext: () => Promise<ChatContext | null>
  onContext: (callback: (payload: ChatContext | null | ChatContextUpdate) => void) => () => void
  ackContext: (payload: { version: number }) => void
  screenshot: (point?: { x: number; y: number }) => Promise<{
    dataUrl: string
    width: number
    height: number
  } | null>
  removeScreenshot: (index: number) => void
  submitRegionSelection: (payload: { x: number; y: number; width: number; height: number }) => void
  submitRegionClick: (point: { x: number; y: number }) => void
  pageDataUrl: () => Promise<string | null>
  getWindowCapture: (point: { x: number; y: number }) => Promise<{
    bounds: { x: number; y: number; width: number; height: number };
    thumbnail: string;
  } | null>
  cancelRegion: () => void
  onRegionReset: (callback: () => void) => () => void
}

export type ElectronRadialApi = {
  onShow: (
    callback: (event: unknown, data: { centerX: number; centerY: number; x?: number; y?: number }) => void
  ) => () => void
  onHide: (callback: () => void) => () => void
  animDone: () => void
  onCursor: (
    callback: (event: unknown, data: { x: number; y: number; centerX: number; centerY: number }) => void
  ) => () => void
}

export type ElectronOverlayApi = {
  setInteractive: (interactive: boolean) => void
  onModifierBlock: (callback: (active: boolean) => void) => () => void
  onStartRegionCapture: (callback: () => void) => () => void
  onEndRegionCapture: (callback: () => void) => () => void
  onShowMini: (callback: (data: { x: number; y: number }) => void) => () => void
  onHideMini: (callback: () => void) => () => void
  onRestoreMini?: (callback: () => void) => () => void
  onShowVoice: (callback: (data: { x: number; y: number; mode: 'stt' | 'realtime' }) => void) => () => void
  onHideVoice: (callback: () => void) => () => void
  onDisplayChange: (callback: (data: { origin: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number } }) => void) => () => void
  onMorphForward: (callback: (data: { screenshotDataUrl: string; x: number; y: number; width: number; height: number }) => void) => () => void
  onMorphReverse: (callback: (data: { screenshotDataUrl: string }) => void) => () => void
  onMorphEnd: (callback: () => void) => () => void
  morphDone: () => void
}

export type ElectronMiniApi = {
  onVisibility: (callback: (visible: boolean) => void) => () => void
  onDismissPreview: (callback: () => void) => () => void
  request: (request: MiniBridgeRequest) => Promise<MiniBridgeResponse>
  onUpdate: (callback: (update: MiniBridgeUpdate) => void) => () => void
  onRequest: (callback: (envelope: MiniBridgeRequestEnvelope) => void) => () => void
  respond: (envelope: MiniBridgeResponseEnvelope) => void
  ready: () => void
  pushUpdate: (update: MiniBridgeUpdate) => void
}

export type ElectronThemeApi = {
  onChange: (callback: (event: unknown, data: { key: string; value: string }) => void) => () => void
  broadcast: (key: string, value: string) => void
  listInstalled: () => Promise<Theme[]>
}

export type VoiceRuntimeSnapshot = {
  sessionState: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnecting'
  isConnected: boolean
  isSpeaking: boolean
  isUserSpeaking: boolean
  micLevel: number
  outputLevel: number
}

export type ElectronVoiceApi = {
  submitTranscript: (transcript: string) => void
  setShortcut: (shortcut: string) => void
  onTranscript: (callback: (transcript: string) => void) => () => void
  persistTranscript: (payload: { conversationId: string; role: 'user' | 'assistant'; text: string }) => void
  orchestratorChat: (payload: { conversationId: string; message: string }) => Promise<string>
  setAssistantSpeaking: (active: boolean) => Promise<{ ok: boolean }>
  getRuntimeState: () => Promise<VoiceRuntimeSnapshot>
  onRuntimeState: (callback: (state: VoiceRuntimeSnapshot) => void) => () => void
  pushRuntimeState: (state: VoiceRuntimeSnapshot) => void
  setRtcShortcut: (shortcut: string) => void
  onRtcPreWarm: (callback: (conversationId: string) => void) => () => void
  onRtcPrefetchToken: (callback: () => void) => () => void
}

export type ElectronAgentApi = {
  healthCheck: () => Promise<AgentHealth | null>
  getActiveRun: () => Promise<{ runId: string; conversationId: string } | null>
  startChat: (payload: {
    conversationId: string
    userMessageId: string
    userPrompt: string
    agentType?: string
    storageMode?: "cloud" | "local"
  }) => Promise<{ runId: string }>
  cancelChat: (runId: string) => void
  resumeStream: (payload: {
    runId: string
    lastSeq: number
  }) => Promise<{
    events: AgentStreamIpcEvent[]
    exhausted: boolean
  }>
  onStream: (callback: (event: AgentStreamIpcEvent) => void) => () => void
  onSelfModHmrState: (callback: (event: { paused: boolean; message: string }) => void) => () => void
  selfModRevert: (featureId?: string, steps?: number) => Promise<unknown>
  getLastSelfModFeature: () => Promise<string | null>
  listSelfModFeatures: (limit?: number) => Promise<SelfModFeatureSummary[]>
  triggerViteError: () => Promise<{ ok: boolean }>
  fixViteError: () => Promise<{ ok: boolean }>
}

export type ElectronSystemApi = {
  getDeviceId: () => Promise<string | null>
  configurePiRuntime: (config: { convexUrl?: string; convexSiteUrl?: string }) => Promise<{ deviceId: string | null }>
  setAuthState: (payload: { authenticated: boolean; token?: string }) => Promise<{ ok: boolean }>
  setCloudSyncEnabled: (payload: { enabled: boolean }) => Promise<{ ok: boolean }>
  onAuthCallback: (callback: (data: { url: string }) => void) => () => void
  openFullDiskAccess: () => void
  openExternal: (url: string) => void
  shellKillByPort: (port: number) => Promise<void>
  getLocalSyncMode: () => Promise<string>
  setLocalSyncMode: (mode: string) => Promise<void>
  listLlmCredentials: () => Promise<LocalLlmCredentialSummary[]>
  saveLlmCredential: (payload: {
    provider: string
    label: string
    plaintext: string
  }) => Promise<LocalLlmCredentialSummary>
  deleteLlmCredential: (provider: string) => Promise<{ removed: boolean }>
  onCredentialRequest: (
    callback: (
      event: unknown,
      data: { requestId: string; provider: string; label?: string; description?: string; placeholder?: string }
    ) => void
  ) => () => void
  submitCredential: (payload: { requestId: string; secretId: string; provider: string; label: string }) => Promise<{ ok: boolean; error?: string }>
  cancelCredential: (payload: { requestId: string }) => Promise<{ ok: boolean; error?: string }>
  getIdentityMap: () => Promise<{ version: number; mappings: { real: { name: string; identifier: string }; alias: { name: string; identifier: string }; source: string }[] }>
  depseudonymize: (text: string) => Promise<string>
  bridgeDeploy: (payload: {
    provider: string; code: string; env: Record<string, string>; dependencies: string
  }) => Promise<{ ok: boolean; error?: string }>
  bridgeStart: (payload: { provider: string }) => Promise<{ ok: boolean; error?: string }>
  bridgeStop: (payload: { provider: string }) => Promise<{ ok: boolean }>
  bridgeStatus: (payload: { provider: string }) => Promise<{ running: boolean }>
}

export type ElectronBrowserApi = {
  checkCoreMemoryExists: () => Promise<boolean>
  collectData: () => Promise<BrowserDataResult>
  detectPreferred: () => Promise<PreferredBrowserProfile>
  listProfiles: (browserType: string) => Promise<BrowserProfile[]>
  writeCoreMemory: (content: string) => Promise<{ ok: boolean; error?: string }>
  collectAllSignals: (options?: { categories?: string[] }) => Promise<AllUserSignalsResult>
  listWorkspacePanels: () => Promise<Array<{ name: string; title: string }>>
  onWorkspacePanelsChanged: (callback: (panels: Array<{ name: string; title: string }>) => void) => () => void
}

export type ElectronScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>
  listConversationEvents: (payload: {
    conversationId: string
    maxItems?: number
  }) => Promise<ScheduledConversationEvent[]>
  getConversationEventCount: (payload: {
    conversationId: string
  }) => Promise<number>
  onUpdated: (callback: () => void) => () => void
}

// ---------------------------------------------------------------------------
// Main ElectronApi — composed from namespaced sub-types
// ---------------------------------------------------------------------------

export type ElectronDisplayApi = {
  onUpdate: (callback: (html: string) => void) => () => void
}

export type ElectronNewsApi = {
  onUpdate: (callback: (html: string) => void) => () => void
}

export type ElectronApi = {
  platform: string
  display: ElectronDisplayApi
  news: ElectronNewsApi
  window: ElectronWindowApi
  ui: ElectronUiApi
  capture: ElectronCaptureApi
  radial: ElectronRadialApi
  overlay: ElectronOverlayApi
  mini: ElectronMiniApi
  theme: ElectronThemeApi
  voice: ElectronVoiceApi
  agent: ElectronAgentApi
  system: ElectronSystemApi
  browser: ElectronBrowserApi
  schedule: ElectronScheduleApi
}

declare global {
  interface Window {
    electronAPI?: ElectronApi
  }
}

export {}


