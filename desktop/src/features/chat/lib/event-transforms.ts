import {
  AGENT_IDS,
  type TaskLifecycleStatus,
  type TaskToolActivity,
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
  ThreadActivityRecord,
  ToolRequestPayload,
  ToolResultPayload,
} from '../../../../../runtime/contracts/local-chat.js'
import { selectLatestAgentAssistantMessage } from './agent-assistant-summary'
import {
  deriveLatestAgentPresentationStatus,
  deriveOwnedAgentPresentationStatus,
  latestAttemptSupersedesAuthoritative,
} from './agent-activity-presentation'

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

type AgentLifecycleFields = {
  /** Root orchestrator run that observed this task transition. This correlates
   * lifecycle packets, but is not a card identity by itself: one root run can
   * call `send_input` on the same thread more than once. Timeline cards use
   * the matching persisted `agent-started` event id. */
  rootRunId?: string
  /** Durable execution epoch for a reused thread. New lifecycle events carry
   *  this on starts, progress, and terminal packets; legacy rows omit it. */
  attemptGeneration?: number
}

type AgentStartedEventPayload = AgentLifecycleFields & {
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

type AgentCompletedEventPayload = AgentLifecycleFields & {
  agentId: string
  result?: string
  fileChanges?: FileChangeRecord[]
  producedFiles?: ProducedFileRecord[]
}

type AgentFailedEventPayload = AgentLifecycleFields & {
  agentId: string
  error?: string
}

type AgentCanceledEventPayload = AgentLifecycleFields & {
  agentId: string
  error?: string
}

type AgentProgressEventPayload = AgentLifecycleFields & {
  agentId: string
  statusText: string
  toolActivity?: TaskToolActivity
}

// Task item for UI display
export type TaskItem = {
  id: string
  description: string
  agentType: string
  status: TaskLifecycleStatus
  /** Durable execution epoch for retry/resume deduplication. */
  attemptGeneration?: number
  /** Root run that owns the thread's latest lifecycle. */
  runId?: string
  anchorTurnId?: string
  parentAgentId?: string
  statusText?: string
  toolActivity?: TaskToolActivity
  reasoningText?: string
  startedAtMs: number
  completedAtMs?: number
  lastUpdatedAtMs: number
  outputPreview?: string
  assistantMessages?: string[]
  assistantMessagesUpdatedAtMs?: number
  assistantMessagesUpdatedSequence?: number
}

export const TASK_COMPLETION_INDICATOR_MS = 3000

/**
 * Ephemeral stream-fed extras for a running thread, keyed by thread id.
 * Structurally matches the streaming store's `TaskDecoration` (defined
 * there to avoid an import cycle). Decoration never carries authoritative
 * fields — status, description, and timestamps come only from the
 * thread-activity rows.
 */
export type TaskLiveDecoration = {
  runId?: string
  /** Lifecycle state observed directly from the ordered agent stream. */
  status?: TaskLifecycleStatus
  /** Durable attempt epoch; lets a resumed run supersede a stale terminal row. */
  attemptGeneration?: number
  /** Receipt time of this attempt's start, used only for legacy packets. */
  startedAtMs?: number
  /** Receipt time of the latest lifecycle packet for this attempt. */
  observedAtMs?: number
  /** Monotonic runtime-recorder sequence for stale packet fencing. */
  lifecycleSequence?: number
  anchorTurnId?: string
  statusText?: string
  toolActivity?: TaskToolActivity
  reasoningText?: string
}

/**
 * Tasks that should drive "is Stella working right now" surfaces: running
 * rows plus terminals fresh enough to still deserve a completion beat.
 * The full task list is durable history (rows persist forever), so
 * presence-driven consumers (pet mood, transient chips) select from this
 * instead — an hour-old error row must not read as "Stella just failed".
 */
export function selectFreshActivityTasks(
  tasks: readonly TaskItem[],
  nowMs = Date.now(),
): TaskItem[] {
  return tasks.filter(
    (task) =>
      task.status === 'running' ||
      (typeof task.completedAtMs === 'number' &&
        nowMs - task.completedAtMs <= TASK_COMPLETION_INDICATOR_MS),
  )
}

/**
 * The Activity task list: authoritative thread rows (from the runtime's
 * `runtime_agents` table via `useThreadActivity`) overlaid with the live
 * stream lifecycle observation. The durable row wins within one attempt;
 * only a strictly newer observed generation may temporarily supersede it
 * while the row refetch catches up.
 */
export function buildActivityTasks(
  records: readonly ThreadActivityRecord[],
  decorations?: Record<string, TaskLiveDecoration>,
): TaskItem[] {
  return records
    .filter((record) => isActivityFeedTask({ agentType: record.agentType }))
    .map((record) => {
      const candidateDecoration = decorations?.[record.threadId]
      const authoritative = {
        status: record.status,
        attemptGeneration: record.attemptGeneration,
        rootRunId: record.rootRunId,
        updatedAtMs: record.updatedAt,
        completedAtMs: record.completedAt,
      }
      const latestAttempt = candidateDecoration
        ? {
            status: candidateDecoration.status,
            attemptGeneration: candidateDecoration.attemptGeneration,
            rootRunId: candidateDecoration.runId,
            startedAtMs: candidateDecoration.startedAtMs,
            observedAtMs: candidateDecoration.observedAtMs,
          }
        : undefined
      const status = deriveLatestAgentPresentationStatus(
        authoritative,
        latestAttempt,
      )
      const running = status === 'running'
      const decoration = running ? candidateDecoration : undefined
      const latestAttemptOwns = latestAttemptSupersedesAuthoritative(
        authoritative,
        latestAttempt,
      )
      const recordOwnsAttempt = !latestAttemptOwns
      const observedDescription = latestAttemptOwns
        ? normalizeTaskDisplayStatusText(candidateDecoration?.statusText)
        : undefined
      return {
        id: record.threadId,
        description: observedDescription ?? record.description,
        agentType: record.agentType,
        status,
        attemptGeneration:
          (latestAttemptOwns
            ? candidateDecoration?.attemptGeneration
            : undefined) ?? record.attemptGeneration,
        runId:
          (latestAttemptOwns ? candidateDecoration?.runId : undefined) ??
          record.rootRunId,
        anchorTurnId: decoration?.anchorTurnId,
        parentAgentId: record.parentAgentId,
        statusText: running
          ? (normalizeTaskDisplayStatusText(decoration?.statusText) ??
            (isGenericTaskDescription(record.description)
              ? undefined
              : record.description))
          : undefined,
        toolActivity: running ? decoration?.toolActivity : undefined,
        reasoningText: running ? decoration?.reasoningText : undefined,
        startedAtMs: record.startedAt,
        completedAtMs: running
          ? undefined
          : latestAttemptOwns
            ? candidateDecoration?.observedAtMs
            : record.completedAt,
        lastUpdatedAtMs:
          (latestAttemptOwns ? candidateDecoration?.observedAtMs : undefined) ??
          record.updatedAt,
        outputPreview:
          running || !recordOwnsAttempt
            ? undefined
            : (record.result ?? record.error),
        assistantMessages: recordOwnsAttempt
          ? record.assistantMessages
          : undefined,
        assistantMessagesUpdatedAtMs: recordOwnsAttempt
          ? record.assistantMessagesUpdatedAt
          : undefined,
        assistantMessagesUpdatedSequence: recordOwnsAttempt
          ? record.assistantMessagesUpdatedSequence
          : undefined,
      }
    })
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
}

const STANDALONE_STATUS_TEXT = new Set(['Pausing'])
const GENERIC_TASK_DESCRIPTION_PATTERN =
  /^(task|agent|work|help|do this|follow up)$/i

export function isGenericTaskDescription(
  description: string | undefined,
): boolean {
  return (
    !description || GENERIC_TASK_DESCRIPTION_PATTERN.test(description.trim())
  )
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
  if (!slug || /^(task|legacy)-/i.test(slug)) return 'Task'
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
 * The user-facing activity feed shows durable delegated work: General agents
 * including those spawned by another agent. Orchestrator-internal helpers (schedule
 * specialists, recall lookups, and any future machinery agent types) remain
 * execution detail and must not surface as activity rows.
 */
export function isActivityFeedTask(task: Pick<TaskItem, 'agentType'>): boolean {
  return task.agentType === AGENT_IDS.GENERAL
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

/**
 * One persisted ownership tree rooted at a Manager (or any future nested
 * owner). `parentAgentId` is the only edge source; labels/group names never
 * participate in ownership. Child rows reuse the same ActivityRow model, so
 * descendants can nest without a second visual language.
 */
export type TaskHierarchy = {
  owner: TaskItem
  children: ActivityRow[]
  /** All descendants, excluding `owner`. */
  descendantCount: number
  /** Aggregate owner/descendant status used by collapsed Activity surfaces. */
  status: TaskLifecycleStatus
}

export type ActivityRow =
  | { kind: 'task'; task: TaskItem }
  | { kind: 'hierarchy'; hierarchy: TaskHierarchy }

export const COMPACT_ACTIVITY_CELL_LIMIT = 16

export type CompactActivitySummary = {
  tasks: TaskItem[]
  totalCount: number
  runningCount: number
  completedCount: number
  errorCount: number
  canceledCount: number
  latestTask?: TaskItem
  latestText?: string
  failureTask?: TaskItem
  usesProgressBar: boolean
}

/** Flatten a nested ownership/group projection into one visual per agent. */
export const flattenActivityTasks = (
  rows: readonly ActivityRow[],
): TaskItem[] => {
  const tasks: TaskItem[] = []
  const append = (row: ActivityRow): void => {
    if (row.kind === 'task') {
      tasks.push(row.task)
      return
    }
    tasks.push(row.hierarchy.owner)
    for (const child of row.hierarchy.children) append(child)
  }
  for (const row of rows) append(row)
  return tasks
}

const compareCompactTaskRecency = (a: TaskItem, b: TaskItem): number =>
  b.lastUpdatedAtMs - a.lastUpdatedAtMs ||
  (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0) ||
  b.startedAtMs - a.startedAtMs ||
  a.id.localeCompare(b.id)

const compactLatestText = (task: TaskItem): string => {
  const assistantText = selectLatestAgentAssistantMessage(
    task.assistantMessages,
  )
  if (assistantText) return assistantText
  switch (task.status) {
    case 'running':
      return 'Working…'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Failed'
    case 'canceled':
      return 'Paused'
  }
}

const compareCompactAssistantRecency = (a: TaskItem, b: TaskItem): number => {
  const aHasText = Boolean(
    selectLatestAgentAssistantMessage(a.assistantMessages),
  )
  const bHasText = Boolean(
    selectLatestAgentAssistantMessage(b.assistantMessages),
  )
  if (aHasText !== bHasText) return Number(bHasText) - Number(aHasText)
  if (aHasText && bHasText) {
    const aSequence = a.assistantMessagesUpdatedSequence
    const bSequence = b.assistantMessagesUpdatedSequence
    if (
      aSequence !== undefined &&
      bSequence !== undefined &&
      aSequence !== bSequence
    ) {
      return bSequence - aSequence
    }
    const byTimestamp =
      (b.assistantMessagesUpdatedAtMs ?? 0) -
      (a.assistantMessagesUpdatedAtMs ?? 0)
    if (byTimestamp !== 0) return byTimestamp
  }
  return compareCompactTaskRecency(a, b)
}

/** Counts and newest-event selection for compact Manager rows. */
export function summarizeCompactActivity(
  tasks: readonly TaskItem[],
): CompactActivitySummary {
  const ordered = [...tasks].sort(compareCompactAssistantRecency)
  const latestTask = ordered[0]
  const failureTask = ordered.find((task) => task.status === 'error')
  return {
    tasks: [...tasks],
    totalCount: tasks.length,
    runningCount: tasks.filter((task) => task.status === 'running').length,
    completedCount: tasks.filter((task) => task.status === 'completed').length,
    errorCount: tasks.filter((task) => task.status === 'error').length,
    canceledCount: tasks.filter((task) => task.status === 'canceled').length,
    latestTask,
    latestText: latestTask ? compactLatestText(latestTask) : undefined,
    failureTask,
    usesProgressBar: tasks.length > COMPACT_ACTIVITY_CELL_LIMIT,
  }
}

/** Single tally line shown under the compact state visualization. */
export function getCompactActivityStatusText(
  summary: CompactActivitySummary,
  prioritizeFailure: boolean,
): string {
  const tally = `${summary.runningCount} running · ${summary.completedCount} done`
  const stopped =
    summary.canceledCount > 0 ? ` · ${summary.canceledCount} stopped` : ''
  if (prioritizeFailure && summary.failureTask) {
    const name = summary.failureTask.description.trim() || 'Agent'
    return `${summary.errorCount} failed — ${name} · ${tally}${stopped}`
  }
  const failed = summary.errorCount > 0 ? ` · ${summary.errorCount} failed` : ''
  const latest = summary.latestText ? ` — latest: ${summary.latestText}` : ''
  return `${tally}${failed}${stopped}${latest}`
}

/** Stable, namespaced identity shared by sorting state and React keys. */
export const activityRowKey = (row: ActivityRow): string =>
  row.kind === 'task'
    ? `task:${row.task.id}`
    : `hierarchy:${row.hierarchy.owner.id}`

export type TopLevelActivityWorkUnit = {
  id: string
  status: TaskLifecycleStatus
}

/**
 * The units represented by top-level Activity rows. A Manager hierarchy is
 * governed by its owner rather than its descendants: owned children never
 * become extra ambient work, even if one remains active while the Manager is
 * paused. Missing/detached parents already fail open as standalone rows in
 * `groupActivityTasks`, so adoption and detachment update the count naturally.
 */
export const deriveTopLevelActivityWorkUnits = (
  tasks: readonly TaskItem[],
): TopLevelActivityWorkUnit[] => {
  const latestById = new Map<string, TaskItem>()
  for (const task of tasks) {
    if (!isActivityFeedTask(task)) continue
    const current = latestById.get(task.id)
    if (
      !current ||
      (task.attemptGeneration ?? 0) > (current.attemptGeneration ?? 0) ||
      ((task.attemptGeneration ?? 0) === (current.attemptGeneration ?? 0) &&
        (task.lastUpdatedAtMs > current.lastUpdatedAtMs ||
          (task.lastUpdatedAtMs === current.lastUpdatedAtMs &&
            task.startedAtMs > current.startedAtMs)))
    ) {
      latestById.set(task.id, task)
    }
  }
  return groupActivityTasks([...latestById.values()]).map((row) => ({
    id: activityRowKey(row),
    status: getActivityRowStatus(row),
  }))
}

export const countActiveTopLevelActivityWorkUnits = (
  tasks: readonly TaskItem[],
): number =>
  deriveTopLevelActivityWorkUnits(tasks).filter(
    (unit) => unit.status === 'running',
  ).length

export const getActivityRowStatus = (row: ActivityRow): TaskLifecycleStatus =>
  row.kind === 'task' ? row.task.status : row.hierarchy.status

export const getActivityRowCompletedAtMs = (row: ActivityRow): number => {
  const entry = row.kind === 'task' ? row.task : row.hierarchy.owner
  return entry.completedAtMs ?? entry.lastUpdatedAtMs ?? entry.startedAtMs
}

/** Search text for a whole visible row, including nested owned descendants. */
export const getActivityRowSearchText = (row: ActivityRow): string => {
  if (row.kind === 'task') {
    return [row.task.description, row.task.statusText, row.task.outputPreview]
      .filter(Boolean)
      .join(' ')
  }
  return [
    row.hierarchy.owner.description,
    row.hierarchy.owner.statusText,
    row.hierarchy.owner.outputPreview,
    ...row.hierarchy.children.map(getActivityRowSearchText),
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Project the persisted task list into Activity rows.
 *
 * Ownership wins first: a task whose `parentAgentId` resolves to another
 * visible task is removed from the root list and nested under that owner.
 * This is what turns Manager + managed agents into one hierarchy, including
 * adopted agents whose persisted parent changes later. Missing parents stay
 * top-level rather than disappearing.
 */
export function groupActivityTasks(tasks: readonly TaskItem[]): ActivityRow[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParentId = new Map<string, TaskItem[]>()
  const ownedTaskIds = new Set<string>()
  for (const task of tasks) {
    const parentId = task.parentAgentId
    if (!parentId || parentId === task.id || !taskById.has(parentId)) continue
    const children = childrenByParentId.get(parentId)
    if (children) children.push(task)
    else childrenByParentId.set(parentId, [task])
    ownedTaskIds.add(task.id)
  }

  const visited = new Set<string>()
  const buildRows = (
    siblings: readonly TaskItem[],
    ancestors: ReadonlySet<string>,
  ): ActivityRow[] => {
    const visibleChildren = (task: TaskItem): TaskItem[] =>
      (childrenByParentId.get(task.id) ?? []).filter(
        (child) => !ancestors.has(child.id) && child.id !== task.id,
      )

    const rows: ActivityRow[] = []
    for (const task of siblings) {
      if (visited.has(task.id)) continue
      const children = visibleChildren(task)
      if (children.length > 0) {
        visited.add(task.id)
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(task.id)
        const childRows = buildRows(children, nextAncestors)
        const status = deriveOwnedAgentPresentationStatus(
          task.status,
          childRows.map(getActivityRowStatus),
        )
        rows.push({
          kind: 'hierarchy',
          hierarchy: {
            owner: task,
            children: childRows,
            descendantCount: countActivityTasks(childRows),
            status,
          },
        })
        continue
      }

      visited.add(task.id)
      rows.push({ kind: 'task', task })
    }
    return rows
  }

  const roots = tasks.filter((task) => !ownedTaskIds.has(task.id))
  const rows = buildRows(roots, new Set())
  // Corrupt/cyclic ownership must not make work disappear. Runtime rejects
  // cycles, but old/imported rows still fail open as top-level activity.
  const unvisited = tasks.filter((task) => !visited.has(task.id))
  if (unvisited.length > 0) rows.push(...buildRows(unvisited, new Set()))
  return rows
}

const countActivityTasks = (rows: readonly ActivityRow[]): number =>
  rows.reduce((total, row) => {
    if (row.kind === 'task') return total + 1
    return total + 1 + row.hierarchy.descendantCount
  }, 0)

/** Agent-authored prose for Activity rows, active or completed. */
export function getTaskAgentUpdates(
  task: Pick<TaskItem, 'status' | 'agentType' | 'assistantMessages'>,
): readonly string[] {
  return (task.assistantMessages ?? []).filter((message) => message.trim())
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
