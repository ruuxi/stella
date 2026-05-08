import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Cron } from 'croner'
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from './shared/private-fs.js'
import {
  runScheduleScript,
  scheduleScriptsDir,
} from './shared/schedule-scripts.js'
import type { StellaHostRunnerTarget } from './lifecycle-targets.js'
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalCronPayload,
  LocalCronSchedule,
  LocalHeartbeatActiveHours,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
  LocalSchedulerSnapshot,
  ScheduledConversationEvent,
} from './shared/scheduling.js'

const DEFAULT_HEARTBEAT_PROMPT =
  'Read the heartbeat checklist if provided. Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, call NoResponse().'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000
const DUPLICATE_SUPPRESSION_MS = 24 * 60 * 60 * 1000
const MIN_HEARTBEAT_INTERVAL_MS = 60_000
const MAX_PREVIEW_CHARS = 800
const MAX_GENERATED_EVENTS_PER_CONVERSATION = 500
const MAX_TIMER_DELAY_MS = 60_000
const ACTIVE_HOURS_TIME_PATTERN = /^([01]\d|2[0-3]|24):([0-5]\d)$/
const STATE_VERSION = 1

type LocalSchedulerState = {
  version: number
  cronJobs: LocalCronJobRecord[]
  heartbeats: LocalHeartbeatConfigRecord[]
  generatedEvents: Record<string, ScheduledConversationEvent[]>
}

/**
 * Optional OS-notification surface. The runtime client wires this to the
 * Electron-side `showStellaNotification` so each delivered scheduled
 * message also pops a native banner. Headless contexts (tests, the
 * mobile/social runtime if it ever embeds the scheduler) leave it
 * undefined and silently skip notifications.
 */
export type LocalSchedulerNotifier = (params: {
  title: string
  body: string
  conversationId: string
  source: 'cron' | 'heartbeat'
  refId: string
}) => void

type LocalSchedulerServiceOptions = {
  stellaHome: string
  runnerTarget: StellaHostRunnerTarget
  showNotification?: LocalSchedulerNotifier
}

const createEmptyState = (): LocalSchedulerState => ({
  version: STATE_VERSION,
  cronJobs: [],
  heartbeats: [],
  generatedEvents: {},
})

const cloneCronJob = (job: LocalCronJobRecord): LocalCronJobRecord => ({
  ...job,
  schedule: { ...job.schedule },
  payload: { ...job.payload },
})

const cloneHeartbeat = (
  config: LocalHeartbeatConfigRecord,
): LocalHeartbeatConfigRecord => ({
  ...config,
  ...(config.activeHours ? { activeHours: { ...config.activeHours } } : {}),
})

const cloneGeneratedEvent = (
  event: ScheduledConversationEvent,
): ScheduledConversationEvent => ({
  ...event,
  payload: { ...event.payload },
})

const truncatePreview = (value: string, maxChars = MAX_PREVIEW_CHARS) =>
  value.length > maxChars ? `${value.slice(0, maxChars)}...` : value

const asTrimmedString = (value: unknown) =>
  typeof value === 'string' ? value.trim() : ''

const normalizeIntervalMs = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS
  }
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(value))
}

const ensureConversationId = (value: unknown) => {
  const conversationId = asTrimmedString(value)
  if (!conversationId) {
    throw new Error('conversationId is required.')
  }
  return conversationId
}

const ensureName = (value: unknown) => {
  const name = asTrimmedString(value)
  if (!name) {
    throw new Error('name is required.')
  }
  return name
}

const assertValidSchedule = (schedule: unknown): LocalCronSchedule => {
  if (!schedule || typeof schedule !== 'object') {
    throw new Error('schedule must be an object.')
  }
  const record = schedule as Record<string, unknown>
  const kind = asTrimmedString(record.kind)
  if (kind === 'at') {
    const atMs = Number(record.atMs)
    if (!Number.isFinite(atMs) || atMs <= 0) {
      throw new Error('schedule.kind="at" requires atMs (epoch ms).')
    }
    return { kind: 'at', atMs }
  }
  if (kind === 'every') {
    const everyMs = Number(record.everyMs)
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error('schedule.kind="every" requires everyMs (> 0).')
    }
    const anchorRaw = record.anchorMs
    const anchorMs =
      typeof anchorRaw === 'number' && Number.isFinite(anchorRaw)
        ? anchorRaw
        : undefined
    return {
      kind: 'every',
      everyMs: Math.floor(everyMs),
      ...(anchorMs ? { anchorMs } : {}),
    }
  }
  if (kind === 'cron') {
    const expr = asTrimmedString(record.expr)
    if (!expr) {
      throw new Error('schedule.kind="cron" requires expr.')
    }
    const tz = asTrimmedString(record.tz)
    return { kind: 'cron', expr, ...(tz ? { tz } : {}) }
  }
  throw new Error('schedule.kind must be "at", "every", or "cron".')
}

const assertValidScriptPath = (
  value: unknown,
  scriptsDir: string,
): string => {
  const raw = asTrimmedString(value)
  if (!raw) {
    throw new Error('payload.kind="script" requires scriptPath.')
  }
  if (!path.isAbsolute(raw)) {
    throw new Error('payload.scriptPath must be absolute.')
  }
  const normalized = path.resolve(raw)
  const dir = path.resolve(scriptsDir)
  const rel = path.relative(dir, normalized)
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.length === 0) {
    throw new Error(
      `payload.scriptPath must live inside ${dir} (got ${normalized}).`,
    )
  }
  return normalized
}

const assertValidPayload = (
  payload: unknown,
  scriptsDir: string,
): LocalCronPayload => {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object.')
  }
  const record = payload as Record<string, unknown>
  const kind = asTrimmedString(record.kind)

  if (kind === 'notify') {
    const text = asTrimmedString(record.text)
    if (!text) {
      throw new Error('payload.kind="notify" requires text.')
    }
    return { kind: 'notify', text }
  }
  if (kind === 'script') {
    const scriptPath = assertValidScriptPath(record.scriptPath, scriptsDir)
    return { kind: 'script', scriptPath }
  }
  if (kind === 'agent') {
    const prompt = asTrimmedString(record.prompt)
    if (!prompt) {
      throw new Error('payload.kind="agent" requires prompt.')
    }
    const agentType = asTrimmedString(record.agentType) || undefined
    return {
      kind: 'agent',
      prompt,
      ...(agentType ? { agentType } : {}),
    }
  }
  throw new Error('payload.kind must be "notify", "script", or "agent".')
}

const computeNextRunAtMs = (schedule: LocalCronSchedule, nowMs: number) => {
  if (schedule.kind === 'at') {
    return schedule.atMs > nowMs ? schedule.atMs : nowMs
  }
  if (schedule.kind === 'every') {
    const everyMs = Math.max(1, Math.floor(schedule.everyMs))
    const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs))
    if (nowMs < anchor) {
      return anchor
    }
    const elapsed = nowMs - anchor
    const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs))
    return anchor + steps * everyMs
  }

  const cron = new Cron(schedule.expr, {
    timezone: schedule.tz?.trim() || undefined,
    catch: false,
  })
  const next = cron.nextRun(new Date(nowMs))
  if (!next) {
    throw new Error('Unable to compute next run for cron expression.')
  }
  return next.getTime()
}

const resolveHeartbeatPrompt = (params: {
  prompt?: string
  checklist?: string
}) => {
  const base = asTrimmedString(params.prompt) || DEFAULT_HEARTBEAT_PROMPT
  const checklist = asTrimmedString(params.checklist)
  if (!checklist) {
    return base
  }
  return `${base}\n\nHeartbeat checklist:\n${checklist}`
}

const isHeartbeatContentEffectivelyEmpty = (
  content: string | undefined,
): boolean => {
  if (content === undefined) {
    return false
  }

  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    if (/^#+(\s|$)/.test(trimmed)) {
      continue
    }
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue
    }
    return false
  }
  return true
}

const normalizeActiveHours = (
  value: unknown,
): LocalHeartbeatActiveHours | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!value || typeof value !== 'object') {
    throw new Error('activeHours must be an object.')
  }
  const record = value as Record<string, unknown>
  const start = asTrimmedString(record.start)
  const end = asTrimmedString(record.end)
  if (!start || !end) {
    throw new Error('activeHours.start and activeHours.end are required.')
  }
  const timezone = asTrimmedString(record.timezone)
  return {
    start,
    end,
    ...(timezone ? { timezone } : {}),
  }
}

const resolveActiveHoursTimezone = (raw?: string) => {
  const trimmed = raw?.trim()
  if (!trimmed || trimmed === 'local' || trimmed === 'user') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date())
    return trimmed
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
}

const parseActiveHoursTime = (
  opts: { allow24: boolean },
  raw?: string,
): number | null => {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null
  }
  const [hourStr, minuteStr] = raw.split(':')
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null
  }
  if (hour === 24) {
    if (!opts.allow24 || minute !== 0) {
      return null
    }
    return 24 * 60
  }
  return hour * 60 + minute
}

const resolveMinutesInTimeZone = (
  nowMs: number,
  timeZone: string,
): number | null => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs))
    const map: Record<string, string> = {}
    for (const part of parts) {
      if (part.type !== 'literal') {
        map[part.type] = part.value
      }
    }
    const hour = Number(map.hour)
    const minute = Number(map.minute)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null
    }
    return hour * 60 + minute
  } catch {
    return null
  }
}

const isWithinActiveHours = (
  active: LocalHeartbeatActiveHours | undefined,
  nowMs: number,
) => {
  if (!active) {
    return true
  }
  const startMin = parseActiveHoursTime({ allow24: false }, active.start)
  const endMin = parseActiveHoursTime({ allow24: true }, active.end)
  if (startMin === null || endMin === null) {
    return true
  }
  if (startMin === endMin) {
    return true
  }
  const currentMin = resolveMinutesInTimeZone(
    nowMs,
    resolveActiveHoursTimezone(active.timezone),
  )
  if (currentMin === null) {
    return true
  }
  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin
  }
  return currentMin >= startMin || currentMin < endMin
}

const sortEventsAscending = (events: ScheduledConversationEvent[]) =>
  [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp
    }
    return a._id.localeCompare(b._id)
  })

const insertEventAscending = (
  events: ScheduledConversationEvent[],
  event: ScheduledConversationEvent,
) => {
  const last = events.at(-1)
  if (
    !last ||
    last.timestamp < event.timestamp ||
    (last.timestamp === event.timestamp &&
      last._id.localeCompare(event._id) <= 0)
  ) {
    events.push(event)
    return
  }

  const index = events.findIndex(
    (existing) =>
      existing.timestamp > event.timestamp ||
      (existing.timestamp === event.timestamp &&
        existing._id.localeCompare(event._id) > 0),
  )
  if (index === -1) {
    events.push(event)
    return
  }
  events.splice(index, 0, event)
}

const sortByUpdatedDesc = <T extends { updatedAt: number; createdAt: number }>(
  rows: T[],
) =>
  [...rows].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return b.updatedAt - a.updatedAt
    }
    return b.createdAt - a.createdAt
  })

const isScheduledConversationEvent = (
  value: unknown,
): value is ScheduledConversationEvent => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record._id === 'string' &&
    typeof record.conversationId === 'string' &&
    typeof record.timestamp === 'number' &&
    record.type === 'assistant_message' &&
    record.payload !== null &&
    typeof record.payload === 'object'
  )
}

const buildCronJobRecordValidator = (scriptsDir: string) =>
  (value: unknown): value is LocalCronJobRecord => {
    if (!value || typeof value !== 'object') {
      return false
    }
    try {
      const record = value as Record<string, unknown>
      assertValidSchedule(record.schedule)
      assertValidPayload(record.payload, scriptsDir)
      ensureConversationId(record.conversationId)
      ensureName(record.name)
      return (
        typeof record.id === 'string' &&
        typeof record.enabled === 'boolean' &&
        typeof record.nextRunAtMs === 'number' &&
        typeof record.createdAt === 'number' &&
        typeof record.updatedAt === 'number'
      )
    } catch {
      return false
    }
  }

const isHeartbeatRecord = (
  value: unknown,
): value is LocalHeartbeatConfigRecord => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  const conversationId = asTrimmedString(record.conversationId)
  return (
    typeof record.id === 'string' &&
    Boolean(conversationId) &&
    typeof record.enabled === 'boolean' &&
    typeof record.intervalMs === 'number' &&
    typeof record.nextRunAtMs === 'number' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  )
}

const sanitizeState = (
  value: unknown,
  scriptsDir: string,
): LocalSchedulerState => {
  if (!value || typeof value !== 'object') {
    return createEmptyState()
  }
  const isCronJobRecord = buildCronJobRecordValidator(scriptsDir)
  const record = value as Record<string, unknown>
  const cronJobs = Array.isArray(record.cronJobs)
    ? record.cronJobs.filter(isCronJobRecord).map(cloneCronJob)
    : []
  const heartbeats = Array.isArray(record.heartbeats)
    ? record.heartbeats.filter(isHeartbeatRecord).map(cloneHeartbeat)
    : []
  const generatedEventsRecord =
    record.generatedEvents && typeof record.generatedEvents === 'object'
      ? (record.generatedEvents as Record<string, unknown>)
      : {}
  const generatedEvents: Record<string, ScheduledConversationEvent[]> = {}

  for (const [conversationId, events] of Object.entries(
    generatedEventsRecord,
  )) {
    if (!Array.isArray(events)) {
      continue
    }
    const validEvents = events
      .filter(isScheduledConversationEvent)
      .map(cloneGeneratedEvent)
    if (validEvents.length > 0) {
      generatedEvents[conversationId] = sortEventsAscending(validEvents).slice(
        -MAX_GENERATED_EVENTS_PER_CONVERSATION,
      )
    }
  }

  return {
    version: STATE_VERSION,
    cronJobs,
    heartbeats,
    generatedEvents,
  }
}

export class LocalSchedulerService {
  private readonly statePath: string
  private readonly scriptsDir: string
  private readonly listeners = new Set<() => void>()
  private state = createEmptyState()
  private timer: NodeJS.Timeout | null = null
  private started = false
  private tickInFlight = false

  constructor(private readonly options: LocalSchedulerServiceOptions) {
    this.statePath = path.join(
      options.stellaHome,
      'state',
      'local-scheduler.json',
    )
    this.scriptsDir = scheduleScriptsDir(options.stellaHome)
  }

  /**
   * Absolute directory under which `payload.kind === 'script'` cron jobs
   * live. Surfaced so the `ScriptDraft` tool can resolve the same path
   * the scheduler validates against.
   */
  getScheduleScriptsDir(): string {
    return this.scriptsDir
  }

  start() {
    if (this.started) {
      return
    }
    this.started = true
    this.state = this.readState()
    if (!fs.existsSync(this.statePath)) {
      this.persistState()
    }
    if (this.clearRecoveredRunningFlags()) {
      this.persistState()
    }
    this.collectOrphanScripts()
    this.scheduleNextTick(250)
  }

  stop() {
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): LocalSchedulerSnapshot {
    return {
      cronJobs: sortByUpdatedDesc(this.state.cronJobs).map(cloneCronJob),
      heartbeats: sortByUpdatedDesc(this.state.heartbeats).map(cloneHeartbeat),
    }
  }

  listCronJobs() {
    return this.getSnapshot().cronJobs
  }

  listHeartbeats() {
    return this.getSnapshot().heartbeats
  }

  getHeartbeatConfig(conversationId: string) {
    const match = this.state.heartbeats.find(
      (config) => config.conversationId === conversationId,
    )
    return match ? cloneHeartbeat(match) : null
  }

  addCronJob(input: LocalCronJobCreateInput) {
    const now = Date.now()
    const conversationId = ensureConversationId(input.conversationId)
    const name = ensureName(input.name)
    const schedule = assertValidSchedule(input.schedule)
    const payload = assertValidPayload(input.payload, this.scriptsDir)
    const enabled = input.enabled !== false
    const nextRunAtMs = computeNextRunAtMs(schedule, now)

    const job: LocalCronJobRecord = {
      id: `cron:${crypto.randomUUID()}`,
      conversationId,
      name,
      ...(asTrimmedString(input.description)
        ? { description: asTrimmedString(input.description) }
        : {}),
      enabled,
      schedule,
      payload,
      ...(typeof input.deliver === 'boolean' ? { deliver: input.deliver } : {}),
      ...(typeof input.deleteAfterRun === 'boolean'
        ? { deleteAfterRun: input.deleteAfterRun }
        : {}),
      nextRunAtMs,
      createdAt: now,
      updatedAt: now,
    }
    this.state.cronJobs.push(job)
    this.afterMutation()
    return cloneCronJob(job)
  }

  updateCronJob(jobId: string, patch: LocalCronJobUpdatePatch) {
    const job = this.state.cronJobs.find((entry) => entry.id === jobId)
    if (!job) {
      return null
    }

    const nextSchedule =
      patch.schedule !== undefined
        ? assertValidSchedule(patch.schedule)
        : job.schedule
    const nextPayload =
      patch.payload !== undefined
        ? assertValidPayload(patch.payload, this.scriptsDir)
        : job.payload

    const now = Date.now()
    const priorScriptPath =
      job.payload.kind === 'script' ? job.payload.scriptPath : null
    job.name = patch.name !== undefined ? ensureName(patch.name) : job.name
    job.conversationId =
      patch.conversationId !== undefined
        ? ensureConversationId(patch.conversationId)
        : job.conversationId
    job.schedule = nextSchedule
    job.payload = nextPayload
    if (patch.description !== undefined) {
      const description = asTrimmedString(patch.description)
      job.description = description || undefined
    }
    if (patch.enabled !== undefined) {
      job.enabled = Boolean(patch.enabled)
    }
    if (patch.deliver !== undefined) {
      job.deliver = patch.deliver
    }
    if (patch.deleteAfterRun !== undefined) {
      job.deleteAfterRun = patch.deleteAfterRun
    }
    job.runningAtMs = undefined
    job.nextRunAtMs = computeNextRunAtMs(nextSchedule, now)
    job.updatedAt = now

    // If we replaced a `script` payload (or swapped to a different kind),
    // the prior script file is now orphaned. Clean it up immediately so
    // we don't accumulate dead `.ts` files in `~/.stella/state/schedule-scripts`.
    if (
      priorScriptPath &&
      (nextPayload.kind !== 'script' ||
        nextPayload.scriptPath !== priorScriptPath) &&
      !this.isScriptPathReferenced(priorScriptPath, job.id)
    ) {
      this.removeScriptFile(priorScriptPath)
    }

    this.afterMutation()
    return cloneCronJob(job)
  }

  removeCronJob(jobId: string) {
    const index = this.state.cronJobs.findIndex((entry) => entry.id === jobId)
    if (index < 0) {
      return false
    }
    const removed = this.state.cronJobs[index]
    this.state.cronJobs.splice(index, 1)
    if (
      removed.payload.kind === 'script' &&
      !this.isScriptPathReferenced(removed.payload.scriptPath, removed.id)
    ) {
      this.removeScriptFile(removed.payload.scriptPath)
    }
    this.afterMutation()
    return true
  }

  runCronJob(jobId: string) {
    const job = this.state.cronJobs.find((entry) => entry.id === jobId)
    if (!job) {
      return null
    }
    job.nextRunAtMs = Date.now()
    job.updatedAt = Date.now()
    this.afterMutation(250)
    return cloneCronJob(job)
  }

  upsertHeartbeat(input: LocalHeartbeatUpsertInput) {
    const conversationId = ensureConversationId(input.conversationId)
    const now = Date.now()
    const intervalMs = normalizeIntervalMs(input.intervalMs)
    const activeHours =
      input.activeHours !== undefined
        ? normalizeActiveHours(input.activeHours)
        : undefined
    const prompt =
      input.prompt !== undefined
        ? asTrimmedString(input.prompt) || undefined
        : undefined
    const checklist =
      input.checklist !== undefined
        ? asTrimmedString(input.checklist) || undefined
        : undefined
    const targetDeviceId =
      input.targetDeviceId !== undefined
        ? asTrimmedString(input.targetDeviceId) || undefined
        : undefined
    const agentType =
      input.agentType !== undefined
        ? asTrimmedString(input.agentType) || undefined
        : undefined
    const ackMaxChars =
      typeof input.ackMaxChars === 'number' &&
      Number.isFinite(input.ackMaxChars)
        ? Math.max(0, Math.floor(input.ackMaxChars))
        : undefined

    const existing = this.state.heartbeats.find(
      (entry) => entry.conversationId === conversationId,
    )
    if (existing) {
      existing.enabled =
        input.enabled !== undefined ? Boolean(input.enabled) : existing.enabled
      existing.intervalMs = intervalMs
      if (input.prompt !== undefined) {
        existing.prompt = prompt
      }
      if (input.checklist !== undefined) {
        existing.checklist = checklist
      }
      if (input.ackMaxChars !== undefined) {
        existing.ackMaxChars = ackMaxChars
      }
      if (input.deliver !== undefined) {
        existing.deliver = input.deliver
      }
      if (input.agentType !== undefined) {
        existing.agentType = agentType
      }
      if (input.activeHours !== undefined) {
        existing.activeHours = activeHours
      }
      if (input.targetDeviceId !== undefined) {
        existing.targetDeviceId = targetDeviceId
      }
      existing.runningAtMs = undefined
      existing.nextRunAtMs = now + intervalMs
      existing.updatedAt = now
      this.afterMutation()
      return cloneHeartbeat(existing)
    }

    const record: LocalHeartbeatConfigRecord = {
      id: `heartbeat:${crypto.randomUUID()}`,
      conversationId,
      enabled: input.enabled !== false,
      intervalMs,
      ...(prompt ? { prompt } : {}),
      ...(checklist ? { checklist } : {}),
      ...(ackMaxChars !== undefined ? { ackMaxChars } : {}),
      ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
      ...(agentType ? { agentType } : {}),
      ...(activeHours ? { activeHours } : {}),
      ...(targetDeviceId ? { targetDeviceId } : {}),
      nextRunAtMs: now + intervalMs,
      createdAt: now,
      updatedAt: now,
    }
    this.state.heartbeats.push(record)
    this.afterMutation()
    return cloneHeartbeat(record)
  }

  runHeartbeat(conversationId: string) {
    const config = this.state.heartbeats.find(
      (entry) => entry.conversationId === conversationId,
    )
    if (!config) {
      return null
    }
    config.nextRunAtMs = Date.now()
    config.updatedAt = Date.now()
    this.afterMutation(250)
    return cloneHeartbeat(config)
  }

  listConversationEvents(conversationId: string, maxItems = 200) {
    const events = this.state.generatedEvents[conversationId] ?? []
    const normalizedMax = Math.max(1, maxItems)
    if (events.length <= normalizedMax) {
      return events.map(cloneGeneratedEvent)
    }
    return events.slice(events.length - normalizedMax).map(cloneGeneratedEvent)
  }

  getConversationEventCount(conversationId: string) {
    return this.state.generatedEvents[conversationId]?.length ?? 0
  }

  private readState(): LocalSchedulerState {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8')
      return sanitizeState(JSON.parse(raw), this.scriptsDir)
    } catch {
      return createEmptyState()
    }
  }

  /**
   * Sweep the schedule-scripts directory and remove any `.ts` file (and
   * matching `.state.json` sidecar) not referenced by an active cron's
   * `payload.scriptPath`. Runs once at startup so iterated `ScriptDraft`
   * attempts that the agent ultimately abandoned don't accumulate.
   *
   * Best-effort: any failure is swallowed — the scripts directory is just
   * a cache of authored work, never load-bearing for live cron firing.
   */
  private collectOrphanScripts() {
    let entries: string[]
    try {
      entries = fs.readdirSync(this.scriptsDir)
    } catch {
      return
    }
    const referenced = new Set<string>()
    for (const job of this.state.cronJobs) {
      if (job.payload.kind === 'script') {
        referenced.add(path.resolve(job.payload.scriptPath))
      }
    }
    for (const entry of entries) {
      if (!entry.endsWith('.ts') && !entry.endsWith('.state.json')) {
        continue
      }
      const abs = path.resolve(this.scriptsDir, entry)
      const tsAbs = entry.endsWith('.state.json')
        ? abs.replace(/\.state\.json$/, '.ts')
        : abs
      if (referenced.has(tsAbs)) {
        continue
      }
      try {
        fs.rmSync(abs, { force: true })
      } catch {
        // Ignore — best-effort cleanup.
      }
    }
  }

  private isScriptPathReferenced(scriptPath: string, exceptJobId?: string) {
    const target = path.resolve(scriptPath)
    return this.state.cronJobs.some(
      (job) =>
        job.id !== exceptJobId &&
        job.payload.kind === 'script' &&
        path.resolve(job.payload.scriptPath) === target,
    )
  }

  private removeScriptFile(scriptPath: string) {
    try {
      fs.rmSync(scriptPath, { force: true })
    } catch {
      // Ignore — script may already be gone.
    }
    try {
      fs.rmSync(`${scriptPath}.state.json`, { force: true })
    } catch {
      // Ignore — sidecar is optional.
    }
  }

  private persistState() {
    const dir = path.dirname(this.statePath)
    if (!fs.existsSync(dir)) {
      ensurePrivateDirSync(dir)
    }
    writePrivateFileSync(this.statePath, JSON.stringify(this.state))
  }

  private emitChange() {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private afterMutation(overrideDelayMs?: number) {
    this.persistState()
    this.emitChange()
    this.scheduleNextTick(overrideDelayMs)
  }

  private clearRecoveredRunningFlags() {
    let changed = false
    for (const job of this.state.cronJobs) {
      if (job.runningAtMs !== undefined) {
        job.runningAtMs = undefined
        changed = true
      }
    }
    for (const config of this.state.heartbeats) {
      if (config.runningAtMs !== undefined) {
        config.runningAtMs = undefined
        changed = true
      }
    }
    return changed
  }

  private scheduleNextTick(overrideDelayMs?: number) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.started) {
      return
    }

    let delayMs = overrideDelayMs
    if (delayMs === undefined) {
      const dueAt = this.getNextDueAt()
      if (dueAt === null) {
        return
      }
      delayMs = Math.max(250, Math.min(dueAt - Date.now(), MAX_TIMER_DELAY_MS))
    }

    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.runDueItems()
      },
      Math.max(0, delayMs),
    )
  }

  private getNextDueAt(): number | null {
    let nextDueAt: number | null = null
    for (const job of this.state.cronJobs) {
      if (!job.enabled || job.runningAtMs !== undefined) {
        continue
      }
      if (nextDueAt === null || job.nextRunAtMs < nextDueAt) {
        nextDueAt = job.nextRunAtMs
      }
    }
    for (const config of this.state.heartbeats) {
      if (!config.enabled || config.runningAtMs !== undefined) {
        continue
      }
      if (nextDueAt === null || config.nextRunAtMs < nextDueAt) {
        nextDueAt = config.nextRunAtMs
      }
    }
    return nextDueAt
  }

  private getRunner() {
    return this.options.runnerTarget.getRunner()
  }

  private getNextDueItem(
    now: number,
  ):
    | { kind: 'cron'; record: LocalCronJobRecord }
    | { kind: 'heartbeat'; record: LocalHeartbeatConfigRecord }
    | null {
    const cronCandidate = this.state.cronJobs
      .filter(
        (job) =>
          job.enabled &&
          job.runningAtMs === undefined &&
          job.nextRunAtMs <= now,
      )
      .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs)[0]
    const heartbeatCandidate = this.state.heartbeats
      .filter(
        (config) =>
          config.enabled &&
          config.runningAtMs === undefined &&
          config.nextRunAtMs <= now,
      )
      .sort((a, b) => a.nextRunAtMs - b.nextRunAtMs)[0]

    if (!cronCandidate && !heartbeatCandidate) {
      return null
    }
    if (!heartbeatCandidate) {
      return { kind: 'cron', record: cronCandidate! }
    }
    if (!cronCandidate) {
      return { kind: 'heartbeat', record: heartbeatCandidate }
    }
    return cronCandidate.nextRunAtMs <= heartbeatCandidate.nextRunAtMs
      ? { kind: 'cron', record: cronCandidate }
      : { kind: 'heartbeat', record: heartbeatCandidate }
  }

  private requiresRunner(
    item: NonNullable<ReturnType<LocalSchedulerService['getNextDueItem']>>,
  ): boolean {
    if (item.kind === 'heartbeat') return true
    return item.record.payload.kind === 'agent'
  }

  private async runDueItems() {
    if (!this.started || this.tickInFlight) {
      return
    }
    this.tickInFlight = true
    let nextDelayOverride: number | undefined

    try {
      while (this.started) {
        const dueItem = this.getNextDueItem(Date.now())
        if (!dueItem) {
          break
        }

        const needsRunner = this.requiresRunner(dueItem)
        const runner = needsRunner ? this.getRunner() : null
        if (needsRunner && !runner) {
          // Worker isn't ready yet; back off and retry. notify/script
          // fires don't need the runner so they continue to drain.
          nextDelayOverride = 5_000
          break
        }

        const result =
          dueItem.kind === 'cron'
            ? await this.executeCronJob(dueItem.record, runner)
            : await this.executeHeartbeat(dueItem.record, runner!)

        if (result === 'busy') {
          nextDelayOverride = 5_000
          break
        }
      }
    } finally {
      this.tickInFlight = false
      this.scheduleNextTick(nextDelayOverride)
    }
  }

  private appendGeneratedAssistantMessage(
    conversationId: string,
    payload: Record<string, unknown>,
  ) {
    const bucket = this.state.generatedEvents[conversationId] ?? []
    insertEventAscending(bucket, {
      _id: `schedule:${crypto.randomUUID()}`,
      conversationId,
      timestamp: Date.now(),
      type: 'assistant_message',
      payload,
    })
    if (bucket.length > MAX_GENERATED_EVENTS_PER_CONVERSATION) {
      bucket.splice(0, bucket.length - MAX_GENERATED_EVENTS_PER_CONVERSATION)
    }
    this.state.generatedEvents[conversationId] = bucket
  }

  private fireOsNotification(params: {
    title: string
    body: string
    conversationId: string
    source: 'cron' | 'heartbeat'
    refId: string
  }) {
    if (!this.options.showNotification) return
    try {
      this.options.showNotification(params)
    } catch {
      // Best-effort: never let a notifier failure break the scheduler tick.
    }
  }

  /**
   * Advance a fired cron's nextRunAtMs / enabled / deleteAfterRun
   * book-keeping. Centralizes the at-vs-recurring policy that ran inline
   * inside the old monolithic executor.
   *
   * Returns whether the job survived (`true`) or was deleted (`false`).
   */
  private advanceCronAfterRun(
    active: LocalCronJobRecord,
    finishedAt: number,
    failed: boolean,
  ): boolean {
    if (active.schedule.kind === 'at') {
      if (failed) {
        active.enabled = false
        return true
      }
      if (active.deleteAfterRun) {
        const removedScript =
          active.payload.kind === 'script' ? active.payload.scriptPath : null
        this.state.cronJobs = this.state.cronJobs.filter(
          (entry) => entry.id !== active.id,
        )
        if (
          removedScript &&
          !this.isScriptPathReferenced(removedScript, active.id)
        ) {
          this.removeScriptFile(removedScript)
        }
        return false
      }
      active.enabled = false
      return true
    }
    active.nextRunAtMs = computeNextRunAtMs(active.schedule, finishedAt)
    return true
  }

  private async executeCronJob(
    job: LocalCronJobRecord,
    runner: ReturnType<LocalSchedulerService['getRunner']> | null,
  ): Promise<'done' | 'busy'> {
    const active = this.state.cronJobs.find((entry) => entry.id === job.id)
    if (!active || !active.enabled) {
      return 'done'
    }

    const startedAt = Date.now()
    active.runningAtMs = startedAt
    active.lastError = undefined
    active.updatedAt = startedAt
    this.persistState()
    this.emitChange()

    switch (active.payload.kind) {
      case 'notify':
        return this.executeCronNotify(active, startedAt)
      case 'script':
        return this.executeCronScript(active, startedAt)
      case 'agent':
        if (!runner) {
          // Shouldn't happen — `requiresRunner` gates this — but if the
          // runner went away mid-tick treat it as busy and retry.
          active.runningAtMs = undefined
          active.updatedAt = Date.now()
          this.persistState()
          this.emitChange()
          return 'busy'
        }
        return this.executeCronAgent(active, runner, startedAt)
    }
  }

  private executeCronNotify(
    active: LocalCronJobRecord,
    startedAt: number,
  ): 'done' {
    if (active.payload.kind !== 'notify') return 'done'
    const finishedAt = Date.now()
    const text = active.payload.text.trim()
    const deliver = active.deliver !== false
    active.runningAtMs = undefined
    active.lastRunAtMs = finishedAt
    active.lastDurationMs = finishedAt - startedAt
    active.lastStatus = text ? 'ok' : 'no-response'
    active.lastError = undefined
    active.lastOutputPreview = text ? truncatePreview(text) : undefined
    active.updatedAt = finishedAt

    if (deliver && text) {
      this.appendGeneratedAssistantMessage(active.conversationId, {
        text,
        source: 'cron',
        cronJobId: active.id,
        cronJobName: active.name,
      })
      this.fireOsNotification({
        title: active.name?.trim() || 'Stella',
        body: text,
        conversationId: active.conversationId,
        source: 'cron',
        refId: active.id,
      })
    }

    this.advanceCronAfterRun(active, finishedAt, false)
    this.persistState()
    this.emitChange()
    return 'done'
  }

  private async executeCronScript(
    active: LocalCronJobRecord,
    startedAt: number,
  ): Promise<'done'> {
    if (active.payload.kind !== 'script') return 'done'
    const scriptPath = active.payload.scriptPath
    let runResult
    try {
      runResult = await runScheduleScript(scriptPath)
    } catch (error) {
      runResult = {
        exitCode: -1,
        stdout: '',
        stderr: (error as Error).message,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      }
    }

    const finishedAt = Date.now()
    active.runningAtMs = undefined
    active.lastRunAtMs = finishedAt
    active.lastDurationMs = finishedAt - startedAt
    active.updatedAt = finishedAt

    const failed = runResult.exitCode !== 0
    if (failed) {
      const errParts = [
        runResult.timedOut
          ? `script timed out after ${runResult.durationMs}ms`
          : `exit ${runResult.exitCode}`,
      ]
      const stderrTrim = runResult.stderr.trim()
      if (stderrTrim) errParts.push(stderrTrim)
      active.lastStatus = runResult.timedOut ? 'timeout' : 'error'
      active.lastError = truncatePreview(errParts.join('\n'))
      active.lastOutputPreview = undefined
      this.advanceCronAfterRun(active, finishedAt, true)
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const text = runResult.stdout.trim()
    const deliver = active.deliver !== false
    active.lastStatus = text ? 'ok' : 'no-response'
    active.lastError = undefined
    active.lastOutputPreview = text ? truncatePreview(text) : undefined

    if (deliver && text) {
      this.appendGeneratedAssistantMessage(active.conversationId, {
        text,
        source: 'cron',
        cronJobId: active.id,
        cronJobName: active.name,
      })
      this.fireOsNotification({
        title: active.name?.trim() || 'Stella',
        body: text,
        conversationId: active.conversationId,
        source: 'cron',
        refId: active.id,
      })
    }

    this.advanceCronAfterRun(active, finishedAt, false)
    this.persistState()
    this.emitChange()
    return 'done'
  }

  private async executeCronAgent(
    active: LocalCronJobRecord,
    runner: NonNullable<ReturnType<LocalSchedulerService['getRunner']>>,
    startedAt: number,
  ): Promise<'done' | 'busy'> {
    if (active.payload.kind !== 'agent') return 'done'

    const runResult = await runner.runAutomationTurn({
      conversationId: active.conversationId,
      userPrompt: active.payload.prompt,
      agentType: active.payload.agentType ?? 'general',
    })

    if (runResult.status === 'busy') {
      active.runningAtMs = undefined
      active.updatedAt = Date.now()
      this.persistState()
      this.emitChange()
      return 'busy'
    }

    const finishedAt = Date.now()
    active.runningAtMs = undefined
    active.lastRunAtMs = finishedAt
    active.lastDurationMs = finishedAt - startedAt
    active.updatedAt = finishedAt

    if (runResult.status === 'error') {
      active.lastStatus = 'error'
      active.lastError = runResult.error
      active.lastOutputPreview = undefined
      this.advanceCronAfterRun(active, finishedAt, true)
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const finalText = runResult.finalText.trim()
    const deliver = active.deliver !== false
    active.lastStatus = finalText ? 'ok' : 'no-response'
    active.lastError = undefined
    active.lastOutputPreview = finalText ? truncatePreview(finalText) : undefined

    if (deliver && finalText) {
      this.appendGeneratedAssistantMessage(active.conversationId, {
        text: finalText,
        source: 'cron',
        cronJobId: active.id,
        cronJobName: active.name,
      })
      this.fireOsNotification({
        title: active.name?.trim() || 'Stella',
        body: finalText,
        conversationId: active.conversationId,
        source: 'cron',
        refId: active.id,
      })
    }

    this.advanceCronAfterRun(active, finishedAt, false)
    this.persistState()
    this.emitChange()
    return 'done'
  }

  private async executeHeartbeat(
    config: LocalHeartbeatConfigRecord,
    runner: NonNullable<ReturnType<LocalSchedulerService['getRunner']>>,
  ): Promise<'done' | 'busy'> {
    const active = this.state.heartbeats.find((entry) => entry.id === config.id)
    if (!active || !active.enabled) {
      return 'done'
    }

    const startedAt = Date.now()
    active.runningAtMs = startedAt
    active.lastError = undefined
    active.updatedAt = startedAt
    this.persistState()
    this.emitChange()

    if (!isWithinActiveHours(active.activeHours, startedAt)) {
      active.runningAtMs = undefined
      active.lastRunAtMs = startedAt
      active.lastStatus = 'skipped:quiet-hours'
      active.nextRunAtMs = startedAt + normalizeIntervalMs(active.intervalMs)
      active.updatedAt = startedAt
      this.persistState()
      this.emitChange()
      return 'done'
    }

    if (
      active.checklist &&
      isHeartbeatContentEffectivelyEmpty(active.checklist)
    ) {
      active.runningAtMs = undefined
      active.lastRunAtMs = startedAt
      active.lastStatus = 'skipped:empty-checklist'
      active.nextRunAtMs = startedAt + normalizeIntervalMs(active.intervalMs)
      active.updatedAt = startedAt
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const runResult = await runner.runAutomationTurn({
      conversationId: active.conversationId,
      userPrompt: resolveHeartbeatPrompt({
        prompt: active.prompt,
        checklist: active.checklist,
      }),
      agentType: active.agentType ?? 'orchestrator',
    })

    if (runResult.status === 'busy') {
      active.runningAtMs = undefined
      active.updatedAt = Date.now()
      this.persistState()
      this.emitChange()
      return 'busy'
    }

    const finishedAt = Date.now()
    active.runningAtMs = undefined
    active.lastRunAtMs = finishedAt
    active.nextRunAtMs = finishedAt + normalizeIntervalMs(active.intervalMs)
    active.updatedAt = finishedAt

    if (runResult.status === 'error') {
      active.lastStatus = 'failed'
      active.lastError = runResult.error
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const finalText = runResult.finalText.trim()
    if (!finalText) {
      active.lastStatus = 'no-response'
      active.lastError = undefined
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const dedupeText = active.lastSentText?.trim() ?? ''
    const lastSentAtMs =
      typeof active.lastSentAtMs === 'number' ? active.lastSentAtMs : 0
    const isDuplicate =
      Boolean(dedupeText) &&
      dedupeText === finalText &&
      lastSentAtMs > 0 &&
      finishedAt - lastSentAtMs < DUPLICATE_SUPPRESSION_MS

    if (isDuplicate) {
      active.lastStatus = 'skipped:duplicate'
      active.lastError = undefined
      this.persistState()
      this.emitChange()
      return 'done'
    }

    const deliver = active.deliver !== false
    if (deliver) {
      this.appendGeneratedAssistantMessage(active.conversationId, {
        text: finalText,
        source: 'heartbeat',
        heartbeatConfigId: active.id,
        reason: 'scheduled',
      })
      this.fireOsNotification({
        title: 'Stella check-in',
        body: finalText,
        conversationId: active.conversationId,
        source: 'heartbeat',
        refId: active.id,
      })
      active.lastSentText = finalText
      active.lastSentAtMs = finishedAt
    }

    active.lastStatus = deliver ? 'sent' : 'completed'
    active.lastError = undefined
    this.persistState()
    this.emitChange()
    return 'done'
  }
}
