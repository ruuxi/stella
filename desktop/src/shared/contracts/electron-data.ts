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
  id: string
  name: string
}

export type DevProject = {
  name: string
  path: string
  lastActivity: number
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
