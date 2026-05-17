import {
  isTerminalTaskLifecycleStatus,
  type TaskLifecycleStatus,
} from '../../../../../runtime/contracts/agent-runtime.js'
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
type AgentStartedEventPayload = {
  agentId: string
  description: string
  agentType: string
  parentAgentId?: string
  agentDepth?: number
  maxAgentDepth?: number
  statusText?: string
}

type AgentCompletedEventPayload = {
  agentId: string
  result?: string
  fileChanges?: FileChangeRecord[]
  producedFiles?: ProducedFileRecord[]
}

type AgentFailedEventPayload = {
  agentId: string
  error?: string
}

type AgentCanceledEventPayload = {
  agentId: string
  error?: string
}

type AgentProgressEventPayload = {
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
  statusText?: string
  reasoningText?: string
  startedAtMs: number
  completedAtMs?: number
  lastUpdatedAtMs: number
  outputPreview?: string
}

export const TASK_COMPLETION_INDICATOR_MS = 3000

/**
 * Strip out general-agent internal tool-call noise from `statusText`
 * (e.g. "Using exec_command", "Using apply_patch") while letting the
 * orchestrator-level overrides ("Updating", "Pausing") and
 * any genuinely meaningful per-agent phrase pass through unchanged.
 *
 * `description` is still the preferred stable subtitle — this just
 * keeps `statusText` available as a fallback when an agent is active
 * but its `description` is generic (e.g. the default "Task") so the
 * working indicator doesn't collapse to a bare "Working".
 */
const NOISY_STATUS_TEXT_PATTERN = /^using\s+/i
const STANDALONE_STATUS_TEXT = new Set(['Updating', 'Pausing'])
const GENERIC_TASK_DESCRIPTION_PATTERN = /^(task|agent|work|help|do this|follow up)$/i

export function isGenericTaskDescription(
  description: string | undefined,
): boolean {
  return !description || GENERIC_TASK_DESCRIPTION_PATTERN.test(description.trim())
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
  if (!statusText) return undefined
  const trimmed = statusText.trim()
  if (!trimmed) return undefined
  if (NOISY_STATUS_TEXT_PATTERN.test(trimmed)) return undefined
  return trimmed
}

export function getTaskDisplayText(task: TaskItem): string {
  if (task.status === 'running') {
    return (
      normalizeTaskDisplayStatusText(task.statusText) ??
      (isGenericTaskDescription(task.description) ? '' : task.description)
    )
  }
  return isGenericTaskDescription(task.description) ? '' : task.description
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
 * the raw event stream can pass it through unchanged — but the cheap
 * path is to pass only the lifecycle events plus
 * `latestMessageTimestampMs` (the latest user/assistant message
 * timestamp anywhere in the conversation, used to auto-complete tasks
 * whose agent never emitted a terminal event but a later turn message
 * proves the work is done).
 */
export function extractTasksFromActivities(
  activities: EventRecord[],
  options?: {
    appSessionStartedAtMs?: number | null
    latestMessageTimestampMs?: number | null
  },
): TaskItem[] {
  const appSessionStartedAtMs = options?.appSessionStartedAtMs ?? null
  const latestMessageTimestampMs = options?.latestMessageTimestampMs ?? null
  const tasksById = new Map<string, TaskItem>()

  const ensureTask = (
    agentId: string,
    timestamp: number,
    overrides?: Partial<TaskItem>,
  ): TaskItem => {
    const previous = tasksById.get(agentId)
    return {
      id: agentId,
      description: previous?.description ?? 'Task',
      agentType: previous?.agentType ?? 'general',
      status: previous?.status ?? 'running',
      parentAgentId: previous?.parentAgentId,
      statusText: normalizeTaskDisplayStatusText(previous?.statusText),
      startedAtMs: previous?.startedAtMs ?? timestamp,
      completedAtMs: previous?.completedAtMs,
      lastUpdatedAtMs: previous?.lastUpdatedAtMs ?? timestamp,
      outputPreview: previous?.outputPreview,
      ...overrides,
    }
  }

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
        }),
      )
      terminalTaskIds.add(event.payload.agentId)
    }
  }

  return [...tasksById.values()]
    .map((task) => {
      let nextTask = task

      if (
        nextTask.status === 'running' &&
        nextTask.agentType === 'schedule' &&
        latestMessageTimestampMs !== null &&
        latestMessageTimestampMs > nextTask.startedAtMs
      ) {
        nextTask = {
          ...nextTask,
          status: 'completed',
          completedAtMs: nextTask.completedAtMs ?? nextTask.lastUpdatedAtMs,
          outputPreview: nextTask.outputPreview ?? 'Scheduling updated.',
        }
      }

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
    return a.startedAtMs - b.startedAtMs
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
      !isTerminalTaskLifecycleStatus(task.status)
    ) {
      continue
    }
    const nextTask =
      persistedTask
        ? {
            ...persistedTask,
            ...task,
            description:
              isGenericTaskDescription(task.description) &&
              !isGenericTaskDescription(persistedTask.description)
                ? persistedTask.description
                : task.description,
            statusText:
              normalizeTaskDisplayStatusText(task.statusText) ??
              normalizeTaskDisplayStatusText(persistedTask.statusText),
          }
        : task
    mergedById.set(task.id, nextTask)
  }

  return sortFooterTasks([...mergedById.values()])
}
