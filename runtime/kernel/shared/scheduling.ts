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

/**
 * Three-tier delivery contract for cron fires.
 *
 *  - `notify` — literal text. The scheduler delivers `text` directly as an
 *    assistant message and an OS notification. No worker turn, no LLM, no
 *    tokens. Use for fixed reminders whose body is fully knowable at
 *    schedule-creation time.
 *  - `script` — programmatic. The scheduler runs `scriptPath` with `bun run`,
 *    captures `stdout` (trimmed) as the message body, and only delivers when
 *    stdout is non-empty. Use for deterministic recurring work (HTTP fetch,
 *    diff against last-seen state, etc.). The script may write a sidecar
 *    `<scriptPath>.state.json` for cross-run memory.
 *  - `agent` — agent turn. The scheduler runs an isolated worker turn against
 *    `agentType` (defaults to general) with the fixed `prompt`. Use only when
 *    the fire genuinely needs reasoning, multi-tool work, or unbounded
 *    interpretation each tick.
 */
export type LocalCronPayload =
  | {
      kind: 'notify'
      text: string
    }
  | {
      kind: 'script'
      scriptPath: string
    }
  | {
      kind: 'agent'
      prompt: string
      agentType?: string
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
  payload: LocalCronPayload
  /**
   * Whether the cron should deliver an assistant message + OS notification
   * when its fire produces text. Defaults to `true`. Heartbeats and most
   * crons want this on; some "background bookkeeping" crons (e.g. silent
   * polling that only logs to lastError) can set it false.
   */
  deliver?: boolean
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
  conversationId: string
  description?: string
  enabled?: boolean
  deliver?: boolean
  deleteAfterRun?: boolean
}

export type LocalCronJobUpdatePatch = {
  name?: string
  schedule?: LocalCronSchedule
  payload?: LocalCronPayload
  conversationId?: string
  description?: string
  enabled?: boolean
  deliver?: boolean
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

/**
 * Structured side-channel returned by the `Schedule` orchestrator tool
 * alongside its plain-text summary. The chat UI uses this to render the
 * inline "Scheduled" receipt chip and link it back to the affected
 * cron / heartbeat rows.
 */
export type ScheduleToolAffectedRef = {
  kind: 'cron' | 'heartbeat'
  id: string
  conversationId: string
  /** Display label: cron `name` or "Check-in" / first ~60 chars of heartbeat prompt. */
  name: string
  enabled: boolean
  nextRunAtMs: number
}

export type ScheduleToolChangeSet = {
  added: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
  updated: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
  removed: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
}

export type ScheduleToolDetails = {
  schedule: {
    /**
     * Snapshot of every entry that was added or updated by this run, taken
     * after the schedule subagent returned. The chip uses this to render
     * one row per affected schedule with current `name` / `nextRunAtMs`.
     */
    affected: ScheduleToolAffectedRef[]
    /** Categorized id-only deltas. `removed` is reported here only. */
    changes: ScheduleToolChangeSet
  }
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
