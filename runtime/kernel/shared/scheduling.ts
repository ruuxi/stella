export type LocalCronSchedule =
  | {
      kind: 'at'
      atMs: number
    }
  | {
      kind: 'every'
      everyMs: number
      anchorMs?: number
    }
  | {
      kind: 'cron'
      expr: string
      tz?: string
    }

export type LocalCronPayload =
  | {
      kind: 'systemEvent'
      text: string
      agentType?: string
      deliver?: boolean
    }
  | {
      kind: 'agentTurn'
      message: string
      agentType?: string
      deliver?: boolean
    }

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

export type LocalSchedulerSnapshot = {
  cronJobs: LocalCronJobRecord[]
  heartbeats: LocalHeartbeatConfigRecord[]
}

export type LocalCronJobCreateInput = {
  name: string
  schedule: LocalCronSchedule
  payload: LocalCronPayload
  sessionTarget: 'main' | 'isolated'
  conversationId: string
  description?: string
  enabled?: boolean
  deleteAfterRun?: boolean
}

export type LocalCronJobUpdatePatch = {
  name?: string
  schedule?: LocalCronSchedule
  payload?: LocalCronPayload
  sessionTarget?: 'main' | 'isolated'
  conversationId?: string
  description?: string
  enabled?: boolean
  deleteAfterRun?: boolean
}

export type LocalHeartbeatUpsertInput = {
  conversationId: string
  enabled?: boolean
  intervalMs?: number
  prompt?: string
  checklist?: string
  ackMaxChars?: number
  deliver?: boolean
  agentType?: string
  activeHours?: LocalHeartbeatActiveHours
  targetDeviceId?: string
}

export type LocalAutomationRunResult =
  | {
      status: 'ok'
      finalText: string
    }
  | {
      status: 'busy'
      finalText: ''
      error: string
    }
  | {
      status: 'error'
      finalText: ''
      error: string
    }
