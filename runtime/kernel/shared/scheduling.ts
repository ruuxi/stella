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
 *    interpretation each tick. Set `threadId` to resume an existing agent
 *    thread with its own history instead of starting a fresh turn — that's
 *    what a wake armed by a subagent uses so the agent picks up where it
 *    left off rather than re-deriving its state.
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
      /**
       * Existing agent thread to resume via `send_input`. When the thread is
       * gone the fire falls back to a fresh automation turn on the
       * conversation, so a wake is never silently dropped.
       */
      threadId?: string
    }

/**
 * Optional gate evaluated before a due cron fires.
 *
 * Without a condition a cron fires on every tick its schedule reaches. With
 * one, the tick runs `command` in the platform shell and only fires the
 * payload when it exits 0 — otherwise the fire is skipped silently and the
 * job reschedules. That turns a plain interval cron into a *watcher*: poll
 * cheaply, deliver once.
 *
 * This is the durable half of the "wake me when X lands" contract. The
 * scheduler lives in the runtime host process and its state is persisted to
 * disk, so a condition outlives the agent turn, the worker, and the engine
 * CLI session that armed it — unlike a background watcher the agent spawns
 * itself, which keeps running but has no way to start a new turn.
 */
export type LocalCronCondition = {
  kind: 'command'
  /** Shell command. Exit 0 means "the thing I was waiting for happened". */
  command: string
  /** Working directory for the check. Defaults to the Stella home. */
  cwd?: string
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
   * Gate the payload behind a shell check. See `LocalCronCondition`. Ticks
   * whose condition fails cost one short command and nothing else — no
   * message, no OS notification, no worker turn.
   */
  condition?: LocalCronCondition
  /**
   * Deadline for a conditional job, epoch ms. Once passed, the next tick
   * fires the payload anyway (flagged as expired) and retires the job, so a
   * condition that never comes true still returns control to the thread
   * instead of leaving it waiting forever.
   */
  expiresAtMs?: number
  /** Epoch ms of the last condition evaluation. */
  lastConditionAtMs?: number
  /** How many times the condition has been evaluated without firing. */
  conditionChecks?: number
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
  condition?: LocalCronCondition
  expiresAtMs?: number
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
  /** Pass `null` to drop the gate and make the job fire on every tick. */
  condition?: LocalCronCondition | null
  /** Pass `null` to clear the deadline. */
  expiresAtMs?: number | null
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
