import {
  AGENT_IDS,
  isTerminalTaskLifecycleStatus,
  type TaskLifecycleStatus,
} from '../../../../../runtime/contracts/agent-runtime.js'
import { normalizeDisplayStatusText } from '../status-utils'
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from '../../../../../runtime/contracts/file-changes.js'
import type {
  Attachment,
  ChannelEnvelope,
  EventRecord,
  MessageMetadata,
  MessagePayload,
  ToolRequestPayload,
  ToolResultPayload,
} from '../../../../../runtime/contracts/local-chat.js'

export type {
  Attachment,
  ChannelEnvelope,
  EventRecord,
  MessageMetadata,
  MessagePayload,
}

interface StepItem {
  id: string
  tool: string
  title?: string
  subtitle?: string
  status: 'pending' | 'running' | 'completed' | 'error'
}

/**
 * Extract the human-readable text from an event payload.
 *
 * Checks `text`, `content`, and `message` fields (in that order), returning
 * the first non-empty string found.  Returns `""` when no text is present.
 */
export const getEventText = (event: EventRecord): string => {
  if (!event.payload || typeof event.payload !== 'object') return ''
  const payload = event.payload as MessagePayload
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text
  }
  return ''
}

// Persisted lifecycle event payloads (kebab-case `agent-*` events). These
// mirror the data emitted by `appendAgentLifecycleChatEvent` in the runner.

/** Work group (`grp-…` key + human label) of the agent's thread. Present
 *  on lifecycle events whose thread was spawned into a group; absent on
 *  ungrouped agents and on legacy persisted events. */
type AgentLifecycleGroupFields = {
  groupKey?: string
  groupLabel?: string
}

type AgentStartedEventPayload = AgentLifecycleGroupFields & {
  agentId: string
  description: string
  agentType: string
  parentAgentId?: string
  agentDepth?: number
  maxAgentDepth?: number
  statusText?: string
  /** `true` when this start re-activates an existing thread (a `send_input`
   *  follow-up) rather than spawning fresh work. The explicit signal the
   *  inline background-work card keys its follow-up variant off. Absent on a
   *  fresh spawn (and on legacy persisted events, which read as spawns). */
  isFollowUp?: boolean
}

type AgentCompletedEventPayload = AgentLifecycleGroupFields & {
  agentId: string
  result?: string
  fileChanges?: FileChangeRecord[]
  producedFiles?: ProducedFileRecord[]
}

type AgentFailedEventPayload = AgentLifecycleGroupFields & {
  agentId: string
  error?: string
}

type AgentCanceledEventPayload = AgentLifecycleGroupFields & {
  agentId: string
  error?: string
}

type AgentProgressEventPayload = AgentLifecycleGroupFields & {
  agentId: string
  statusText: string
}

// Task item for UI display
export type TaskItem = {
  id: string
  description: string
  agentType: string
  status: TaskLifecycleStatus
  /** Identifier of the agent run that owns this task. Set when a task is
   *  produced from streaming events (resume snapshots, task-upserts).
   *  Tasks reconstructed from local persisted events may not have it. */
  runId?: string
  anchorTurnId?: string
  parentAgentId?: string
  /** Work group this task's agent thread was spawned into. Tasks sharing
   *  a groupKey collapse under one Activity group header; absent for
   *  ungrouped agents and legacy persisted events. */
  groupKey?: string
  groupLabel?: string
  statusText?: string
  reasoningText?: string
  startedAtMs: number
  completedAtMs?: number
  lastUpdatedAtMs: number
  outputPreview?: string
}

export const TASK_COMPLETION_INDICATOR_MS = 3000

const STANDALONE_STATUS_TEXT = new Set(['Pausing'])
const GENERIC_TASK_DESCRIPTION_PATTERN = /^(task|agent|work|help|do this|follow up)$/i

export function isGenericTaskDescription(
  description: string | undefined,
): boolean {
  return !description || GENERIC_TASK_DESCRIPTION_PATTERN.test(description.trim())
}

/**
 * Best-effort display name for a task whose spawn description is missing
 * (e.g. a resumed legacy thread rebuilt from reasoning-only events). Thread
 * ids are slugs of the original spawn description (`compare-flight-prices`),
 * so de-slugging the id recovers a meaningful label. Ordinal/namespace ids
 * (`task-7`, `grp-…`) carry no words, so they fall back to plain "Task".
 */
// Spawn-thread ids are minted by `slugify()` (runtime/kernel/shared/slug.ts):
// lowercase a-z0-9 words joined by single dashes, no leading/trailing dash,
// capped at 48 chars. Ids from any other generator (uppercase, underscores,
// other alphabets, overlong) may embed text that was never meant as a display
// label — treat those as opaque and keep the generic "Task".
const SPAWN_SLUG_MAX_LENGTH = 48
const SPAWN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function fallbackTaskDescription(agentId: string | undefined): string {
  const slug = (agentId ?? '').trim()
  if (!slug || /^(task|grp|legacy)-/i.test(slug)) return 'Task'
  if (slug.length > SPAWN_SLUG_MAX_LENGTH || !SPAWN_SLUG_PATTERN.test(slug)) {
    return 'Task'
  }
  const words = slug.split('-')
  const letterCount = (words.join('').match(/[a-z]/gi) ?? []).length
  // Short single-token ids ("a1", "x7f3") are opaque junk, not slugged
  // descriptions — keep the generic label for those.
  if (words.length < 2 && letterCount < 4) return 'Task'
  if (letterCount === 0) return 'Task'
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The user-facing activity feed shows the user's delegated work: GENERAL
 * agents spawned via `spawn_agent`. Orchestrator-internal helpers (schedule
 * specialists, recall lookups, and any future machinery agent types) are
 * execution detail — they must not surface as activity rows, and must not
 * burn progress-summary LLM calls.
 */
export function isActivityFeedTask(
  task: Pick<TaskItem, 'agentType'>,
): boolean {
  return task.agentType === AGENT_IDS.GENERAL
}

/** True when a description is the generic placeholder or merely the
 *  de-slugged id — i.e. it should lose to any real spawn description. */
export function isFallbackTaskDescription(
  description: string | undefined,
  agentId: string | undefined,
): boolean {
  return (
    isGenericTaskDescription(description) ||
    description?.trim() === fallbackTaskDescription(agentId)
  )
}

export function isStandaloneTaskStatusText(
  statusText: string | undefined,
): boolean {
  const normalized = normalizeTaskDisplayStatusText(statusText)
  return Boolean(normalized && STANDALONE_STATUS_TEXT.has(normalized))
}

export function normalizeTaskDisplayStatusText(
  statusText: string | undefined,
): string | undefined {
  return normalizeDisplayStatusText(statusText)
}

export function getTaskDisplayText(task: TaskItem): string {
  const description = isGenericTaskDescription(task.description)
    ? ''
    : task.description

  if (task.status === 'running') {
    const statusText = normalizeTaskDisplayStatusText(task.statusText)
    if (statusText && !isStandaloneTaskStatusText(statusText)) {
      return statusText
    }
    return description
  }
  return description
}

export function getTaskWorkingIndicatorText(task: TaskItem): string {
  const statusText = normalizeTaskDisplayStatusText(task.statusText)
  if (
    task.status === 'running' &&
    statusText &&
    isStandaloneTaskStatusText(statusText)
  ) {
    const description = isGenericTaskDescription(task.description)
      ? ''
      : task.description
    return description ? `${statusText} · ${description}` : statusText
  }
  return getTaskDisplayText(task)
}

// Generic type guard factory — reduces per-event-type boilerplate.
function createEventGuard<T extends Record<string, unknown>>(
  type: string,
  requiredFields?: (keyof T)[],
) {
  return (event: EventRecord): event is EventRecord & { payload: T } =>
    event.type === type &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    (requiredFields === undefined ||
      requiredFields.every((field) => field in (event.payload as object)))
}

export const isToolRequest = createEventGuard<ToolRequestPayload>(
  'tool_request',
  ['toolName'],
)

export const isToolResult = createEventGuard<ToolResultPayload>('tool_result')

export function isUserMessage(event: EventRecord): boolean {
  return event.type === 'user_message'
}

export function isAssistantMessage(event: EventRecord): boolean {
  return event.type === 'assistant_message'
}

export const isAgentStartedEvent = createEventGuard<AgentStartedEventPayload>(
  'agent-started',
  ['agentId'],
)

export const isAgentCompletedEvent =
  createEventGuard<AgentCompletedEventPayload>('agent-completed', ['agentId'])

export const isAgentFailedEvent = createEventGuard<AgentFailedEventPayload>(
  'agent-failed',
  ['agentId'],
)

export const isAgentCanceledEvent = createEventGuard<AgentCanceledEventPayload>(
  'agent-canceled',
  ['agentId'],
)

export const isAgentProgressEvent = createEventGuard<AgentProgressEventPayload>(
  'agent-progress',
  ['agentId', 'statusText'],
)

export function extractToolTitle(event: EventRecord): string {
  if (!isToolRequest(event)) return ''

  const { toolName, args } = event.payload

  const str = (v: unknown) => v as string

  switch (toolName.toLowerCase()) {
    case 'read':
      return args?.path ? str(args.path).split('/').pop()! : 'Reading file'
    case 'write':
      return args?.path ? str(args.path).split('/').pop()! : 'Writing file'
    case 'edit':
      return args?.path ? str(args.path).split('/').pop()! : 'Editing file'
    case 'grep':
      return args?.pattern ? `"${str(args.pattern).slice(0, 30)}"` : 'Searching'
    case 'executetypescript':
      return args?.summary
        ? str(args.summary).slice(0, 40)
        : 'Running code mode'
    case 'glob':
      return args?.pattern ? str(args.pattern) : 'Finding files'
    case 'bash':
      return args?.command
        ? str(args.command).slice(0, 40) +
            (str(args.command).length > 40 ? '...' : '')
        : 'Running command'
    case 'webfetch':
      return args?.url ? new URL(str(args.url)).hostname : 'Fetching'
    case 'web':
      if (args?.url) {
        try {
          return new URL(str(args.url)).hostname
        } catch {
          return 'Fetching'
        }
      }
      return args?.query
        ? `"${str(args.query).slice(0, 40)}${str(args.query).length > 40 ? '…' : ''}"`
        : 'Searching the web'
    case 'task':
      return args?.description
        ? str(args.description).slice(0, 40)
        : 'Delegating'
    default:
      return toolName
  }
}

// Helper to get requestId from event (can be at top level or in payload)
function getRequestId(event: EventRecord): string | undefined {
  // Check top level first
  if (event.requestId) return event.requestId
  // Then check payload
  if (event.payload && typeof event.payload === 'object') {
    const payload = event.payload as { requestId?: string }
    if (payload.requestId) return payload.requestId
  }
  return undefined
}

export function extractStepsFromEvents(events: EventRecord[]): StepItem[] {
  const steps: StepItem[] = []
  const stepIndexByRequestId = new Map<string, number>()

  for (const event of events) {
    if (isToolRequest(event)) {
      const requestId = getRequestId(event) ?? event._id
      const toolName = event.payload.toolName
      const stepIndex = steps.length
      steps.push({
        id: requestId,
        tool: toolName,
        title: extractToolTitle(event),
        status: 'running',
      })
      stepIndexByRequestId.set(requestId, stepIndex)
      continue
    }

    if (!isToolResult(event)) {
      continue
    }

    const status: StepItem['status'] = event.payload.error
      ? 'error'
      : 'completed'
    const requestId = getRequestId(event)

    if (requestId) {
      const directIndex = stepIndexByRequestId.get(requestId)
      if (
        directIndex !== undefined &&
        steps[directIndex]?.status === 'running'
      ) {
        steps[directIndex] = { ...steps[directIndex], status }
        continue
      }
    }
  }

  return steps
}

/**
 * Returns the currently-running tool call (name + stable request id),
 * if any.
 *
 * Walks each message's turn-scoped `toolEvents` and pairs requests with
 * results by requestId. Returns the unmatched (still running) one.
 *
 * The `id` doubles as a stable seed for the working-indicator's
 * variation picker — it stays constant for the duration of one tool
 * call so the friendly label doesn't flicker on each re-render.
 */
export function getCurrentRunningTool(
  messages: { toolEvents: EventRecord[] }[],
): { tool: string; id: string } | undefined {
  const events: EventRecord[] = []
  for (const message of messages) {
    if (message.toolEvents.length === 0) continue
    for (const toolEvent of message.toolEvents) events.push(toolEvent)
  }
  const running = extractStepsFromEvents(events).find(
    (s) => s.status === 'running',
  )
  return running ? { tool: running.tool, id: running.id } : undefined
}

// Extract tasks from events
export function extractTasksFromEvents(
  events: EventRecord[],
  options?: { appSessionStartedAtMs?: number | null },
): TaskItem[] {
  let latestMessageTimestampMs: number | null = null
  for (const event of events) {
    if (!isUserMessage(event) && !isAssistantMessage(event)) continue
    if (
      latestMessageTimestampMs === null ||
      event.timestamp > latestMessageTimestampMs
    ) {
      latestMessageTimestampMs = event.timestamp
    }
  }
  return extractTasksFromActivities(events, {
    appSessionStartedAtMs: options?.appSessionStartedAtMs ?? null,
    latestMessageTimestampMs,
  })
}

/**
 * Reduce a stream of agent-* lifecycle events into `TaskItem`s. Same
 * folding logic the prior `extractTasksFromEvents` did inline, factored
 * so the activity stream (`useConversationActivity`) can feed task state
 * without dragging the full message/event stream along just to compute
 * the stale-schedule auto-completion.
 *
 * Non-activity events in `activities` are ignored, so callers that have
 * the raw event stream can pass it through unchanged — the cheap path is
 * to pass only the lifecycle events. (`latestMessageTimestampMs` is
 * accepted for caller compatibility; it only drove the auto-completion of
 * stale schedule-specialist rows, which are now excluded entirely by the
 * general-agents-only activity filter.)
 */
export function extractTasksFromActivities(
  activities: EventRecord[],
  options?: {
    appSessionStartedAtMs?: number | null
    latestMessageTimestampMs?: number | null
  },
): TaskItem[] {
  const appSessionStartedAtMs = options?.appSessionStartedAtMs ?? null
  const tasksById = new Map<string, TaskItem>()

  const ensureTask = (
    agentId: string,
    timestamp: number,
    overrides?: Partial<TaskItem>,
  ): TaskItem => {
    const previous = tasksById.get(agentId)
    return {
      id: agentId,
      description: previous?.description ?? fallbackTaskDescription(agentId),
      agentType: previous?.agentType ?? 'general',
      status: previous?.status ?? 'running',
      parentAgentId: previous?.parentAgentId,
      groupKey: previous?.groupKey,
      groupLabel: previous?.groupLabel,
      statusText: normalizeTaskDisplayStatusText(previous?.statusText),
      startedAtMs: previous?.startedAtMs ?? timestamp,
      completedAtMs: previous?.completedAtMs,
      lastUpdatedAtMs: previous?.lastUpdatedAtMs ?? timestamp,
      outputPreview: previous?.outputPreview,
      ...overrides,
    }
  }

  // Every lifecycle event type carries the group fields (the runner
  // enriches them centrally), so any event may upgrade a task from
  // ungrouped to grouped — but a group-less event never clears them.
  const groupOverrides = (
    payload: AgentLifecycleGroupFields,
  ): Partial<TaskItem> =>
    payload.groupKey
      ? {
          groupKey: payload.groupKey,
          ...(payload.groupLabel ? { groupLabel: payload.groupLabel } : {}),
        }
      : {}

  // Once a task reaches a terminal state, only a fresh `agent-started`
  // (send_input re-activation) may revive it. This guards against in-flight
  // `agent-progress` events that race with `agent-canceled` and would
  // otherwise flip the task back to "running" — the renderer treats that
  // resurrected task as live and pins a phantom "Working … Task" chip in
  // the footer.
  const terminalTaskIds = new Set<string>()

  for (const event of activities) {
    if (isAgentStartedEvent(event)) {
      const previous = tasksById.get(event.payload.agentId)
      tasksById.set(event.payload.agentId, {
        id: event.payload.agentId,
        description: event.payload.description,
        agentType: event.payload.agentType,
        status: 'running',
        parentAgentId: event.payload.parentAgentId,
        groupKey: event.payload.groupKey ?? previous?.groupKey,
        groupLabel: event.payload.groupLabel ?? previous?.groupLabel,
        statusText:
          normalizeTaskDisplayStatusText(event.payload.statusText) ??
          normalizeTaskDisplayStatusText(previous?.statusText) ??
          (isGenericTaskDescription(event.payload.description)
            ? undefined
            : event.payload.description),
        startedAtMs: event.timestamp,
        completedAtMs: undefined,
        lastUpdatedAtMs: event.timestamp,
        outputPreview: undefined,
      })
      terminalTaskIds.delete(event.payload.agentId)
      continue
    }

    if (isAgentProgressEvent(event)) {
      if (terminalTaskIds.has(event.payload.agentId)) {
        continue
      }
      const previous = tasksById.get(event.payload.agentId)
      tasksById.set(
        event.payload.agentId,
        ensureTask(event.payload.agentId, event.timestamp, {
          status: 'running',
          statusText:
            normalizeTaskDisplayStatusText(event.payload.statusText) ??
            normalizeTaskDisplayStatusText(previous?.statusText),
          completedAtMs: undefined,
          lastUpdatedAtMs: event.timestamp,
          outputPreview: undefined,
          ...groupOverrides(event.payload),
        }),
      )
      continue
    }

    if (isAgentCompletedEvent(event)) {
      tasksById.set(
        event.payload.agentId,
        ensureTask(event.payload.agentId, event.timestamp, {
          status: 'completed',
          statusText: undefined,
          completedAtMs: event.timestamp,
          lastUpdatedAtMs: event.timestamp,
          outputPreview: event.payload.result,
          ...groupOverrides(event.payload),
        }),
      )
      terminalTaskIds.add(event.payload.agentId)
      continue
    }

    if (isAgentFailedEvent(event)) {
      tasksById.set(
        event.payload.agentId,
        ensureTask(event.payload.agentId, event.timestamp, {
          status: 'error',
          statusText: undefined,
          completedAtMs: event.timestamp,
          lastUpdatedAtMs: event.timestamp,
          outputPreview: event.payload.error,
          ...groupOverrides(event.payload),
        }),
      )
      terminalTaskIds.add(event.payload.agentId)
      continue
    }

    if (isAgentCanceledEvent(event)) {
      tasksById.set(
        event.payload.agentId,
        ensureTask(event.payload.agentId, event.timestamp, {
          status: 'canceled',
          statusText: undefined,
          completedAtMs: event.timestamp,
          lastUpdatedAtMs: event.timestamp,
          outputPreview: event.payload.error ?? 'Canceled',
          ...groupOverrides(event.payload),
        }),
      )
      terminalTaskIds.add(event.payload.agentId)
    }
  }

  return [...tasksById.values()]
    // Internal helper agents (schedule specialists, etc.) are not user
    // work — keep them out of every activity-derived task list.
    .filter(isActivityFeedTask)
    .map((task) => {
      let nextTask = task

      if (
        nextTask.status === 'running' &&
        appSessionStartedAtMs !== null &&
        nextTask.lastUpdatedAtMs < appSessionStartedAtMs
      ) {
        nextTask = {
          ...nextTask,
          status: 'canceled',
          completedAtMs: nextTask.completedAtMs ?? nextTask.lastUpdatedAtMs,
          outputPreview:
            nextTask.outputPreview ?? 'Stopped when Stella restarted.',
        }
      }

      return nextTask
    })
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
}

const sortFooterTasks = (tasks: TaskItem[]): TaskItem[] =>
  [...tasks].sort((a, b) => {
    const aCompleted = a.status === 'completed'
    const bCompleted = b.status === 'completed'
    if (aCompleted !== bCompleted) {
      return aCompleted ? 1 : -1
    }
    // Tie-break on the stable `id` so same-timestamp tasks keep a fixed
    // order instead of swapping when this re-runs against a re-merged list.
    return a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id)
  })

export function getFooterTasksFromEvents(
  events: EventRecord[],
  options?: {
    appSessionStartedAtMs?: number | null
    nowMs?: number
    completionIndicatorMs?: number
  },
): TaskItem[] {
  const tasks = extractTasksFromEvents(events, {
    appSessionStartedAtMs: options?.appSessionStartedAtMs,
  })
  return getFooterTasksFromTasks(tasks, options)
}

export function getFooterTasksFromTasks(
  tasks: TaskItem[],
  options?: {
    nowMs?: number
    completionIndicatorMs?: number
  },
): TaskItem[] {
  const nowMs = options?.nowMs ?? Date.now()
  const completionIndicatorMs =
    options?.completionIndicatorMs ?? TASK_COMPLETION_INDICATOR_MS
  return sortFooterTasks(
    tasks.filter((task) => {
      if (task.status === 'running') {
        return true
      }
      if (task.status !== 'completed') {
        return false
      }
      if (typeof task.completedAtMs !== 'number') {
        return false
      }
      return nowMs - task.completedAtMs <= completionIndicatorMs
    }),
  )
}

/**
 * One collapsed Activity entry for tasks sharing a `groupKey` (agents
 * spawned into the same work group). Aggregated from the member tasks
 * by `groupActivityTasks`.
 */
export type TaskGroup = {
  groupKey: string
  label: string
  /** Members in spawn order (startedAtMs asc, id tie-break). */
  members: TaskItem[]
  /** Aggregate: any member running → running; else any error → error;
   *  else any completed → completed; else canceled. */
  status: TaskLifecycleStatus
  completedCount: number
  totalCount: number
  startedAtMs: number
  completedAtMs?: number
  lastUpdatedAtMs: number
}

export type ActivityRow =
  | { kind: 'task'; task: TaskItem }
  | { kind: 'group'; group: TaskGroup }

const buildTaskGroup = (groupKey: string, members: TaskItem[]): TaskGroup => {
  const ordered = [...members].sort(
    (a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id),
  )
  const completedCount = ordered.filter(
    (member) => member.status === 'completed',
  ).length
  const status: TaskLifecycleStatus = ordered.some(
    (member) => member.status === 'running',
  )
    ? 'running'
    : ordered.some((member) => member.status === 'error')
      ? 'error'
      : completedCount > 0
        ? 'completed'
        : 'canceled'
  return {
    groupKey,
    label:
      ordered.find((member) => member.groupLabel)?.groupLabel ??
      ordered[0].description,
    members: ordered,
    status,
    completedCount,
    totalCount: ordered.length,
    startedAtMs: Math.min(...ordered.map((member) => member.startedAtMs)),
    completedAtMs:
      status === 'running'
        ? undefined
        : Math.max(
            ...ordered.map(
              (member) => member.completedAtMs ?? member.lastUpdatedAtMs,
            ),
          ),
    lastUpdatedAtMs: Math.max(
      ...ordered.map((member) => member.lastUpdatedAtMs),
    ),
  }
}

/**
 * Collapse tasks sharing a `groupKey` into one `TaskGroup` row (emitted
 * at the first member's position in the input order). Ungrouped tasks
 * and singleton groups pass through as plain `task` rows, so legacy
 * events with no group fields produce exactly the same rows as before.
 */
export function groupActivityTasks(
  tasks: readonly TaskItem[],
): ActivityRow[] {
  const membersByGroupKey = new Map<string, TaskItem[]>()
  for (const task of tasks) {
    if (!task.groupKey) continue
    const members = membersByGroupKey.get(task.groupKey)
    if (members) {
      members.push(task)
    } else {
      membersByGroupKey.set(task.groupKey, [task])
    }
  }

  const rows: ActivityRow[] = []
  const emittedGroupKeys = new Set<string>()
  for (const task of tasks) {
    const members = task.groupKey
      ? membersByGroupKey.get(task.groupKey)
      : undefined
    if (!task.groupKey || !members || members.length < 2) {
      rows.push({ kind: 'task', task })
      continue
    }
    if (emittedGroupKeys.has(task.groupKey)) continue
    emittedGroupKeys.add(task.groupKey)
    rows.push({ kind: 'group', group: buildTaskGroup(task.groupKey, members) })
  }
  return rows
}

/**
 * Prune group expand/collapse overrides whose group no longer has ANY member
 * in the task list. Deliberately keyed off tasks' `groupKey` rather than the
 * rendered group rows: a group that temporarily shrinks to a single member
 * renders as a plain task row (see {@link groupActivityTasks}), and the
 * user's explicit expand/collapse choice must survive until the group
 * regrows. Returns `overrides` unchanged when nothing is stale.
 */
export function pruneGroupExpandOverrides(
  overrides: ReadonlyMap<string, boolean>,
  tasks: readonly TaskItem[],
): ReadonlyMap<string, boolean> {
  if (overrides.size === 0) return overrides
  const liveKeys = new Set<string>()
  for (const task of tasks) {
    if (task.groupKey) liveKeys.add(task.groupKey)
  }
  let stale = false
  for (const key of overrides.keys()) {
    if (!liveKeys.has(key)) {
      stale = true
      break
    }
  }
  if (!stale) return overrides
  const next = new Map<string, boolean>()
  for (const [key, value] of overrides) {
    if (liveKeys.has(key)) next.set(key, value)
  }
  return next
}

/**
 * Whether an activity row should render its rolling reasoning/progress
 * summaries. Summaries narrate what the agent is doing RIGHT NOW, so they
 * only display while it's actually working; once the agent stops (finished,
 * failed, canceled) they collapse away and the row keeps just the files —
 * per Rahul: "it's correct to collapse the reasoning summaries specifically
 * and no longer show them when not active. but the files should still
 * display." A `send_input` re-activation flips the task back to running and
 * the (still-accumulated) summaries show again.
 */
export function shouldShowTaskReasoningSummaries(
  task: Pick<TaskItem, 'status'>,
): boolean {
  return task.status === 'running'
}

/**
 * Roll the "has been seen running this session" id set forward for a new
 * task list. An id enters the set while its task is running and STAYS in it
 * after the task completes — this is what keeps a finished agent's activity
 * row expanded (its default expansion is `running || seenRunning`) instead
 * of snapping shut the moment the terminal lifecycle event lands. Ids whose
 * task left the list entirely (aged out of the activity window, conversation
 * switch) are pruned so the set can't grow unboundedly. Returns `seen`
 * unchanged (same reference) when nothing changed.
 */
export function updateSeenRunningTaskIds(
  seen: ReadonlySet<string>,
  tasks: readonly TaskItem[],
): ReadonlySet<string> {
  let changed = false
  const present = new Set<string>()
  for (const task of tasks) present.add(task.id)
  const next = new Set<string>()
  for (const id of seen) {
    if (present.has(id)) next.add(id)
    else changed = true
  }
  for (const task of tasks) {
    if (task.status === 'running' && !next.has(task.id)) {
      next.add(task.id)
      changed = true
    }
  }
  return changed ? next : seen
}

/**
 * Group-key variant of {@link updateSeenRunningTaskIds}: a group counts as
 * running while ANY member is running, and its key survives (keeping the
 * group's default expansion open) until no member remains in the task list.
 * Keyed off tasks' `groupKey` — not the rendered group rows — for the same
 * reason as {@link pruneGroupExpandOverrides}: a group that shrinks to a
 * single member renders as a plain task row but must not lose its state.
 */
export function updateSeenRunningGroupKeys(
  seen: ReadonlySet<string>,
  tasks: readonly TaskItem[],
): ReadonlySet<string> {
  let changed = false
  const presentKeys = new Set<string>()
  const runningKeys = new Set<string>()
  for (const task of tasks) {
    if (!task.groupKey) continue
    presentKeys.add(task.groupKey)
    if (task.status === 'running') runningKeys.add(task.groupKey)
  }
  const next = new Set<string>()
  for (const key of seen) {
    if (presentKeys.has(key)) next.add(key)
    else changed = true
  }
  for (const key of runningKeys) {
    if (!next.has(key)) {
      next.add(key)
      changed = true
    }
  }
  return changed ? next : seen
}

/** Persistent first-seen ordering state for {@link orderByFirstSeen}. */
export type FirstSeenOrder = {
  /** Frozen insertion index per item key. */
  order: ReadonlyMap<string, number>
  /** Next index to hand out to a newly-seen key. */
  next: number
}

export const EMPTY_FIRST_SEEN_ORDER: FirstSeenOrder = {
  order: new Map(),
  next: 0,
}

/**
 * Order `items` by the sequence in which their keys were *first* seen and
 * pin them there for as long as they stay present. This gives running
 * activity rows a stable position that survives live updates: sorting them
 * by any recomputed field (e.g. `startedAtMs`, which drifts forward once an
 * agent's original `agent-started` event ages out of the rolling activity
 * window) would re-shuffle the list on every streamed delta.
 *
 * Keys that dropped out of `items` are pruned from the returned state, so a
 * later re-activation of the same key re-enters at the end rather than
 * reclaiming its old slot. Pure — the caller threads the returned state
 * back in (typically via a ref) on the next call.
 *
 * With `descending`, the newest-seen key sorts first: a freshly-seen key
 * prepends at the top while every already-seen key keeps its relative
 * order (shifting down by one). Frozen indices are unchanged either way,
 * so existing rows never reshuffle relative to each other.
 */
export function orderByFirstSeen<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  prev: FirstSeenOrder = EMPTY_FIRST_SEEN_ORDER,
  descending = false,
): { ordered: T[]; state: FirstSeenOrder } {
  const order = new Map<string, number>()
  let next = prev.next
  for (const item of items) {
    const key = keyOf(item)
    if (order.has(key)) continue
    const existing = prev.order.get(key)
    if (existing === undefined) {
      order.set(key, next)
      next += 1
    } else {
      order.set(key, existing)
    }
  }
  const ordered = [...items].sort((a, b) => {
    const aKey = keyOf(a)
    const bKey = keyOf(b)
    const ai = order.get(aKey) ?? 0
    const bi = order.get(bKey) ?? 0
    return descending
      ? bi - ai || bKey.localeCompare(aKey)
      : ai - bi || aKey.localeCompare(bKey)
  })
  return { ordered, state: { order, next } }
}

/**
 * Meta line for a group header: a stable "{N} tasks" count of the group's
 * members. Deliberately does NOT surface any individual member's
 * description/narration — deriving the header from child agents made the
 * row flicker between siblings' text on every streamed update. The group's
 * own label carries the title; this count only changes when membership does.
 */
export function getTaskGroupStatusText(group: TaskGroup): string {
  return group.totalCount === 1 ? '1 task' : `${group.totalCount} tasks`
}

export function mergeFooterTasks(
  persistedTasks: TaskItem[],
  liveTasks?: TaskItem[],
): TaskItem[] {
  if (!liveTasks || liveTasks.length === 0) {
    return sortFooterTasks(persistedTasks)
  }

  const mergedById = new Map<string, TaskItem>()

  for (const task of persistedTasks) {
    mergedById.set(task.id, task)
  }

  for (const task of liveTasks) {
    const persistedTask = mergedById.get(task.id)
    if (
      persistedTask &&
      isTerminalTaskLifecycleStatus(persistedTask.status) &&
      !isTerminalTaskLifecycleStatus(task.status) &&
      (typeof persistedTask.completedAtMs !== 'number' ||
        task.startedAtMs <= persistedTask.completedAtMs)
    ) {
      continue
    }
    const nextTask =
      persistedTask
        ? {
            ...persistedTask,
            ...task,
            // A live task can carry a fallback label that is merely the
            // de-slugged id ("Fix the bug" from `fix-the-bug`) — that must
            // not overwrite a richer persisted spawn description, so compare
            // with the fallback-aware check rather than generic-only.
            description:
              isFallbackTaskDescription(task.description, task.id) &&
              !isFallbackTaskDescription(
                persistedTask.description,
                persistedTask.id,
              )
                ? persistedTask.description
                : task.description,
            statusText:
              normalizeTaskDisplayStatusText(task.statusText) ??
              normalizeTaskDisplayStatusText(persistedTask.statusText),
            completedAtMs:
              task.status === 'running'
                ? undefined
                : (task.completedAtMs ?? persistedTask.completedAtMs),
            outputPreview:
              task.status === 'running'
                ? undefined
                : (task.outputPreview ?? persistedTask.outputPreview),
            // Live tasks hydrated from resume snapshots don't carry group
            // fields; never let them clear the persisted group membership.
            groupKey: task.groupKey ?? persistedTask.groupKey,
            groupLabel: task.groupLabel ?? persistedTask.groupLabel,
          }
        : task
    mergedById.set(task.id, nextTask)
  }

  return sortFooterTasks([...mergedById.values()])
}
