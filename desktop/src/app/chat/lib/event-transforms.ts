import type { OfficePreviewRef } from '@/shared/contracts/office-preview'
import type { TaskLifecycleStatus } from '@/shared/contracts/agent-runtime'

export interface StepItem {
  id: string
  tool: string
  title?: string
  subtitle?: string
  status: 'pending' | 'running' | 'completed' | 'error'
}

export type EventRecord = {
  _id: string
  timestamp: number
  type: string
  deviceId?: string
  requestId?: string
  targetDeviceId?: string
  payload?: Record<string, unknown>
  channelEnvelope?: ChannelEnvelope
}

export type ToolRequestPayload = {
  toolName: string
  args?: Record<string, unknown>
  targetDeviceId?: string
  agentType?: string
}

// Tool result payload structure
export type ToolResultPayload = {
  toolName: string
  result?: unknown
  resultPreview?: string
  error?: string
  requestId?: string
  agentType?: string
  officePreviewRef?: OfficePreviewRef
}

// Attachment structure
export type Attachment = {
  id?: string
  url?: string
  mimeType?: string
  name?: string
  size?: number
  kind?: string
  providerMeta?: unknown
}

export type ChannelReaction = {
  emoji: string
  action: 'add' | 'remove'
  targetMessageId?: string
}

export type ChannelEnvelope = {
  provider: string
  kind: 'message' | 'reaction' | 'edit' | 'delete' | 'system'
  chatType?: string
  externalUserId?: string
  externalChatId?: string
  externalMessageId?: string
  threadId?: string
  text?: string
  attachments?: Attachment[]
  reactions?: ChannelReaction[]
  sourceTimestamp?: number
  providerPayload?: unknown
}

// Message payload structure
export type MessagePayload = {
  text?: string
  contextText?: string
  role?: string
  source?: string
  agentType?: string
  attachments?: Attachment[]
  mode?: string
  /** Set on assistant_message events to thread back to the user message
   *  that triggered them (used by the renderer to pin the in-flight turn
   *  and dismiss the pending state once the assistant reply lands). */
  userMessageId?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  metadata?: MessageMetadata
}

export type MessageMetadata = {
  ui?: {
    visibility?: 'visible' | 'hidden'
  }
  context?: {
    windowLabel?: string
    windowPreviewImageUrl?: string
  }
  trigger?: {
    kind?: string
    source?: string
  }
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
export type AgentStartedEventPayload = {
  agentId: string
  description: string
  agentType: string
  parentAgentId?: string
  agentDepth?: number
  maxAgentDepth?: number
}

export type AgentCompletedEventPayload = {
  agentId: string
  result?: string
}

export type AgentFailedEventPayload = {
  agentId: string
  error?: string
}

export type AgentCanceledEventPayload = {
  agentId: string
  error?: string
}

export type AgentProgressEventPayload = {
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
  const pendingByTool = new Map<string, number[]>()

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

      const queue = pendingByTool.get(toolName)
      if (queue) {
        queue.push(stepIndex)
      } else {
        pendingByTool.set(toolName, [stepIndex])
      }
      continue
    }

    if (!isToolResult(event)) {
      continue
    }

    const toolName = event.payload.toolName
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

    const queue = pendingByTool.get(toolName)
    if (!queue || queue.length === 0) {
      continue
    }

    // Fallback for results without request IDs: consume the oldest pending step with the same tool.
    while (queue.length > 0) {
      const pendingIndex = queue.shift()
      if (pendingIndex === undefined) {
        break
      }
      if (steps[pendingIndex]?.status === 'running') {
        steps[pendingIndex] = { ...steps[pendingIndex], status }
        break
      }
    }
  }

  return steps
}

export type MessageTurn = {
  id: string
  userMessage: EventRecord
  assistantMessage?: EventRecord
  toolEvents: EventRecord[]
  steps: StepItem[]
}

// Group events into message turns
export function groupEventsIntoTurns(events: EventRecord[]): MessageTurn[] {
  const turns: MessageTurn[] = []
  let currentTurn: MessageTurn | null = null

  for (const event of events) {
    if (isUserMessage(event)) {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn)
      }
      currentTurn = {
        id: event._id,
        userMessage: event,
        toolEvents: [],
        steps: [],
      }
    } else if (isAssistantMessage(event)) {
      if (currentTurn && !currentTurn.assistantMessage) {
        // Attach to existing turn
        currentTurn.assistantMessage = event
      } else {
        if (currentTurn) {
          turns.push(currentTurn)
          currentTurn = null
        }
        // Standalone assistant message (e.g., welcome message)
        // Create a synthetic turn with an empty user message
        turns.push({
          id: event._id,
          userMessage: {
            _id: `synthetic-${event._id}`,
            timestamp: event.timestamp,
            type: 'user_message',
            payload: { text: '' },
          },
          assistantMessage: event,
          toolEvents: [],
          steps: [],
        })
      }
    } else if (currentTurn) {
      if (isToolRequest(event) || isToolResult(event)) {
        currentTurn.toolEvents.push(event)
      }
    }
  }

  // Push the last turn
  if (currentTurn) {
    turns.push(currentTurn)
  }

  // Compute steps for each turn
  for (const turn of turns) {
    turn.steps = extractStepsFromEvents(turn.toolEvents)
  }

  return turns
}

// Get the currently running tool name
export function getCurrentRunningTool(
  events: EventRecord[],
): string | undefined {
  const turns = groupEventsIntoTurns(events)
  return getCurrentRunningToolFromTurns(turns, events)
}

export function getCurrentRunningToolFromTurns(
  turns: MessageTurn[],
  fallbackEvents?: EventRecord[],
): string | undefined {
  const latestTurn = turns.at(-1)
  if (!latestTurn) {
    const running = fallbackEvents
      ? extractStepsFromEvents(fallbackEvents).find(
          (s) => s.status === 'running',
        )
      : undefined
    return running?.tool
  }
  if (latestTurn.assistantMessage) {
    return undefined
  }
  const running = latestTurn.steps.find((s) => s.status === 'running')
  return running?.tool
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
      statusText: previous?.statusText,
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
      tasksById.set(event.payload.agentId, {
        id: event.payload.agentId,
        description: event.payload.description,
        agentType: event.payload.agentType,
        status: 'running',
        parentAgentId: event.payload.parentAgentId,
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
      tasksById.set(
        event.payload.agentId,
        ensureTask(event.payload.agentId, event.timestamp, {
          status: 'running',
          statusText: event.payload.statusText,
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

// Get currently running tasks
export function getRunningTasks(
  events: EventRecord[],
  options?: { appSessionStartedAtMs?: number | null },
): TaskItem[] {
  const tasks = extractTasksFromEvents(events, options)
  return getRunningTasksFromTasks(tasks)
}

export function getRunningTasksFromTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.filter((t) => t.status === 'running')
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
    mergedById.set(
      task.id,
      persistedTask ? { ...persistedTask, ...task } : task,
    )
  }

  return sortFooterTasks([...mergedById.values()])
}
