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
    return normalizeAssistantDisplayText(payload.text)
  }
  return ''
}

const normalizeAssistantDisplayText = (text: string): string => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("[") || !trimmed.includes("output_text")) {
    return text
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) {
      const parts = parsed
        .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
        .map((item) => item.text as string)
        .filter((value) => value.length > 0)
      if (parts.length > 0) return parts.join('')
    }
  } catch {
    // Fireworks can return a Python-repr-style content list through compat paths.
  }

  const parts: string[] = []
  const singleQuotedText = /'text'\s*:\s*'((?:\\.|[^'\\])*)'/g
  for (const match of trimmed.matchAll(singleQuotedText)) {
    parts.push(
      match[1]
        .replace(/\\'/g, "'")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\"),
    )
  }
  const singleKeyDoubleQuotedText = /'text'\s*:\s*"((?:\\.|[^"\\])*)"/g
  for (const match of trimmed.matchAll(singleKeyDoubleQuotedText)) {
    try {
      parts.push(JSON.parse(`"${match[1]}"`) as string)
    } catch {
      parts.push(
        match[1]
          .replace(/\\"/g, '"')
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\"),
      )
    }
  }
  return parts.length > 0 ? parts.join('') : text
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
 * orchestrator-level overrides ("Updating", "Pausing", "Queued") and
 * any genuinely meaningful per-agent phrase pass through unchanged.
 *
 * `description` is still the preferred stable subtitle — this just
 * keeps `statusText` available as a fallback when an agent is active
 * but its `description` is generic (e.g. the default "Task") so the
 * working indicator doesn't collapse to a bare "Working".
 */
const NOISY_STATUS_TEXT_PATTERN = /^using\s+/i

export function normalizeTaskDisplayStatusText(
  statusText: string | undefined,
): string | undefined {
  if (!statusText) return undefined
  const trimmed = statusText.trim()
  if (!trimmed) return undefined
  if (NOISY_STATUS_TEXT_PATTERN.test(trimmed)) return undefined
  return trimmed
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
 * Linear-history pipeline: walks all tool_request/tool_result events,
 * pairs them by requestId, and returns the unmatched (still running)
 * one. Independent of message-turn grouping (which no longer exists).
 *
 * The `id` doubles as a stable seed for the working-indicator's
 * variation picker — it stays constant for the duration of one tool
 * call so the friendly label doesn't flicker on each re-render.
 */
export function getCurrentRunningTool(
  events: EventRecord[],
): { tool: string; id: string } | undefined {
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
  const appSessionStartedAtMs = options?.appSessionStartedAtMs ?? null
  const laterTurnMessages = events.filter(
    (event) => isUserMessage(event) || isAssistantMessage(event),
  )
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

  for (const event of events) {
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
          normalizeTaskDisplayStatusText(previous?.statusText),
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
        laterTurnMessages.some(
          (messageEvent) => messageEvent.timestamp > nextTask.startedAtMs,
        )
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
    mergedById.set(task.id, persistedTask ? { ...persistedTask, ...task } : task)
  }

  return sortFooterTasks([...mergedById.values()])
}
