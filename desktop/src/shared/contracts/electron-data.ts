import type { DiscoveryCategory } from './discovery'

export type RadialWedge = 'capture' | 'chat' | 'full' | 'voice' | 'auto' | 'dismiss'

export type WindowBounds = { x: number; y: number; width: number; height: number }

export type ChatContext = {
  window: {
    title: string
    app: string
    bounds: WindowBounds
  } | null
  browserUrl?: string | null
  selectedText?: string | null
  regionScreenshots?: {
    dataUrl: string
    width: number
    height: number
  }[]
  capturePending?: boolean
  /** Text content extracted from a window via accessibility APIs (used by Auto mode). */
  windowText?: string | null
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
  | {
      type: 'mutation:cancelStream'
      conversationId: string
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
      type: 'mutation:cancelStream'
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

export type ClusterKeyword = {
  keyword: string
  score: number
  lastVisit: number // ms since epoch
}

export type BrowserData = {
  browser: BrowserType | null
  clusterDomains: string[]
  recentDomains: DomainVisit[]
  allTimeDomains: DomainVisit[]
  domainDetails: Record<string, DomainDetail[]>
  clusterKeywords: ClusterKeyword[]
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
  id: string
  name: string
}

export type DevProject = {
  name: string
  path: string
  lastActivity: number
}

export type LocalDevProjectSource = 'discovered' | 'manual'

export type LocalDevProjectFramework =
  | 'next'
  | 'vite'
  | 'create-react-app'
  | 'angular'
  | 'unknown'

export type LocalDevProjectPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type LocalDevProjectStatus = 'stopped' | 'starting' | 'running' | 'error'

export type LocalDevProjectRuntime = {
  status: LocalDevProjectStatus
  port?: number
  url?: string
  error?: string
}

export type LocalDevProjectRecord = {
  id: string
  name: string
  path: string
  source: LocalDevProjectSource
  framework: LocalDevProjectFramework
  packageManager: LocalDevProjectPackageManager
  createdAt: number
  updatedAt: number
  lastDetectedAt?: number
  runtime: LocalDevProjectRuntime
}

export type CommandFrequency = {
  command: string
  count: number
}

export type ShellAnalysis = {
  topCommands: CommandFrequency[]
  projectPaths: string[]
  toolsUsed: string[]
}

export type DiscoveredApp = {
  name: string
  executablePath: string
  source: 'running' | 'recent'
  lastUsed?: number
}

export type AllUserSignals = {
  browser: BrowserData
  devProjects: DevProject[]
  shell: ShellAnalysis
  apps: DiscoveredApp[]
}

export type AllUserSignalsResult = {
  data: AllUserSignals | null
  formatted: string | null
  formattedSections?: Partial<Record<DiscoveryCategory, string>> | null
  error?: string
}

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

export type SelfModBatchState = 'committed' | 'blocked' | 'published'

export type SelfModBatchRecord = {
  batchId: string
  featureId: string
  runId?: string
  ordinal: number
  state: SelfModBatchState
  commitHash?: string
  files: string[]
  blockedFiles?: string[]
  packageId?: string
  releaseNumber?: number
  createdAt: number
  updatedAt: number
}

export type SelfModFeatureRecord = {
  featureId: string
  name: string
  description: string
  packageId?: string
  createdAt: number
  updatedAt: number
}

export type StoreReleaseBlueprintFile = {
  path: string
  changeType: 'create' | 'update' | 'delete'
  deleted?: boolean
  referenceContentBase64?: string
}

export type StoreReleaseBlueprintBatch = {
  batchId: string
  ordinal: number
  commitHash: string
  files: string[]
  subject: string
  body: string
  patch: string
}

export type StoreReleaseArtifact = {
  kind: 'self_mod_blueprint'
  schemaVersion: 1
  manifest: StoreReleaseManifest
  applyGuidance: string
  batches: StoreReleaseBlueprintBatch[]
  files: StoreReleaseBlueprintFile[]
}

export type StoreReleaseManifest = {
  featureId: string
  packageId: string
  releaseNumber: number
  displayName: string
  description: string
  releaseNotes?: string
  batchIds: string[]
  commitHashes: string[]
  files: string[]
  createdAt: number
}

export type StorePackageRecord = {
  packageId: string
  featureId: string
  displayName: string
  description: string
  latestReleaseNumber: number
  createdAt: number
  updatedAt: number
}

export type StoreReleaseDraft = {
  feature: SelfModFeatureRecord
  batches: SelfModBatchRecord[]
  selectedBatchIds: string[]
  packageId?: string
  displayName: string
  description: string
}

export type StorePackageReleaseRecord = {
  packageId: string
  releaseNumber: number
  manifest: StoreReleaseManifest
  storageKey: string
  artifactUrl?: string | null
  createdAt: number
}

export type InstalledStoreModRecord = {
  installId: string
  packageId: string
  featureId: string
  releaseNumber: number
  applyCommitHashes: string[]
  state: 'installed' | 'uninstalled'
  createdAt: number
  updatedAt: number
}

export type SelfModHmrPhase =
  | 'idle'
  | 'paused'
  | 'morph-forward'
  | 'applying'
  | 'reloading'
  | 'morph-reverse'

export type SelfModHmrState = {
  phase: SelfModHmrPhase
  paused: boolean
  requiresFullReload: boolean
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

export type VoiceRuntimeSnapshot = {
  sessionState: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnecting'
  isConnected: boolean
  isSpeaking: boolean
  isUserSpeaking: boolean
  micLevel: number
  outputLevel: number
}

export type SocialSessionRuntimeRecord = {
  sessionId: string
  role: 'host' | 'follower'
  hostDeviceId: string
  isActiveHost: boolean
  localFolderPath: string
  localFolderName: string
  lastAppliedFileOpOrdinal: number
  lastObservedTurnOrdinal: number
}

export type SocialSessionServiceSnapshot = {
  enabled: boolean
  status: 'stopped' | 'connecting' | 'running' | 'error'
  deviceId?: string
  sessionCount: number
  sessions: SocialSessionRuntimeRecord[]
  lastError?: string
  lastSyncAt?: number
  processingTurnId?: string
}
