export interface StepItem {
  id: string;
  tool: string;
  title?: string;
  subtitle?: string;
  status: "pending" | "running" | "completed" | "error";
}

export type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
  channelEnvelope?: ChannelEnvelope;
};

export type ToolRequestPayload = {
  toolName: string;
  args?: Record<string, unknown>;
  targetDeviceId?: string;
  agentType?: string;
};

// Tool result payload structure
export type ToolResultPayload = {
  toolName: string;
  result?: unknown;
  resultPreview?: string;
  html?: string;
  error?: string;
  requestId?: string;
};

// Attachment structure
export type Attachment = {
  id?: string;
  url?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  kind?: string;
  providerMeta?: unknown;
};

export type ChannelReaction = {
  emoji: string;
  action: "add" | "remove";
  targetMessageId?: string;
};

export type ChannelEnvelope = {
  provider: string;
  kind: "message" | "reaction" | "edit" | "delete" | "system";
  chatType?: string;
  externalUserId?: string;
  externalChatId?: string;
  externalMessageId?: string;
  threadId?: string;
  text?: string;
  attachments?: Attachment[];
  reactions?: ChannelReaction[];
  sourceTimestamp?: number;
  providerPayload?: unknown;
};

// Message payload structure
export type MessagePayload = {
  text?: string;
  contextText?: string;
  role?: string;
  source?: string;
  agentType?: string;
  attachments?: Attachment[];
  mode?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

/**
 * Extract the human-readable text from an event payload.
 *
 * Checks `text`, `content`, and `message` fields (in that order), returning
 * the first non-empty string found.  Returns `""` when no text is present.
 */
export const getEventText = (event: EventRecord): string => {
  if (!event.payload || typeof event.payload !== "object") return "";
  const payload = event.payload as MessagePayload;
  if (typeof payload.text === "string" && payload.text.trim().length > 0)
    return payload.text;
  return "";
};

// Task event payload structures
export type TaskStartedPayload = {
  taskId: string;
  description: string;
  agentType: string;
  parentTaskId?: string;
  taskDepth?: number;
  maxTaskDepth?: number;
  skillIds?: string[];
};

export type TaskCompletedPayload = {
  taskId: string;
  result?: string;
};

export type TaskFailedPayload = {
  taskId: string;
  error?: string;
};

export type TaskProgressPayload = {
  taskId: string;
  statusText: string;
};

// Task item for UI display
export type TaskItem = {
  id: string;
  description: string;
  agentType: string;
  status: "running" | "completed" | "error";
  parentTaskId?: string;
  statusText?: string;
};

// Generic type guard factory — reduces per-event-type boilerplate.
function createEventGuard<T extends Record<string, unknown>>(
  type: string,
  requiredFields?: (keyof T)[],
) {
  return (event: EventRecord): event is EventRecord & { payload: T } =>
    event.type === type &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    (requiredFields === undefined ||
      requiredFields.every((field) => field in (event.payload as object)));
}

export const isToolRequest = createEventGuard<ToolRequestPayload>(
  "tool_request",
  ["toolName"],
);

export const isToolResult = createEventGuard<ToolResultPayload>(
  "tool_result",
);

export function isUserMessage(event: EventRecord): boolean {
  return event.type === "user_message";
}

export function isAssistantMessage(event: EventRecord): boolean {
  return event.type === "assistant_message";
}

export const isTaskStarted = createEventGuard<TaskStartedPayload>(
  "task_started",
  ["taskId"],
);

export const isTaskCompleted = createEventGuard<TaskCompletedPayload>(
  "task_completed",
  ["taskId"],
);

export const isTaskFailed = createEventGuard<TaskFailedPayload>(
  "task_failed",
  ["taskId"],
);

export const isTaskProgress = createEventGuard<TaskProgressPayload>(
  "task_progress",
  ["taskId", "statusText"],
);

export function extractToolTitle(event: EventRecord): string {
  if (!isToolRequest(event)) return "";

  const { toolName, args } = event.payload;

  const str = (v: unknown) => v as string;

  switch (toolName.toLowerCase()) {
    case "read":
      return args?.path ? str(args.path).split("/").pop()! : "Reading file";
    case "write":
      return args?.path ? str(args.path).split("/").pop()! : "Writing file";
    case "edit":
      return args?.path ? str(args.path).split("/").pop()! : "Editing file";
    case "grep":
      return args?.pattern ? `"${str(args.pattern).slice(0, 30)}"` : "Searching";
    case "glob":
      return args?.pattern ? str(args.pattern) : "Finding files";
    case "bash":
      return args?.command
        ? str(args.command).slice(0, 40) + (str(args.command).length > 40 ? "..." : "")
        : "Running command";
    case "webfetch":
      return args?.url ? new URL(str(args.url)).hostname : "Fetching";
    case "task":
      return args?.description ? str(args.description).slice(0, 40) : "Delegating";
    default:
      return toolName;
  }
}

// Helper to get requestId from event (can be at top level or in payload)
function getRequestId(event: EventRecord): string | undefined {
  // Check top level first
  if (event.requestId) return event.requestId;
  // Then check payload
  if (event.payload && typeof event.payload === "object") {
    const payload = event.payload as { requestId?: string };
    if (payload.requestId) return payload.requestId;
  }
  return undefined;
}

export function extractStepsFromEvents(events: EventRecord[]): StepItem[] {
  const steps: StepItem[] = [];
  const stepIndexByRequestId = new Map<string, number>();
  const pendingByTool = new Map<string, number[]>();

  for (const event of events) {
    if (isToolRequest(event)) {
      const requestId = getRequestId(event) ?? event._id;
      const toolName = event.payload.toolName;
      const stepIndex = steps.length;
      steps.push({
        id: requestId,
        tool: toolName,
        title: extractToolTitle(event),
        status: "running",
      });
      stepIndexByRequestId.set(requestId, stepIndex);

      const queue = pendingByTool.get(toolName);
      if (queue) {
        queue.push(stepIndex);
      } else {
        pendingByTool.set(toolName, [stepIndex]);
      }
      continue;
    }

    if (!isToolResult(event)) {
      continue;
    }

    const toolName = event.payload.toolName;
    const status: StepItem["status"] = event.payload.error ? "error" : "completed";
    const requestId = getRequestId(event);

    if (requestId) {
      const directIndex = stepIndexByRequestId.get(requestId);
      if (directIndex !== undefined && steps[directIndex]?.status === "running") {
        steps[directIndex] = { ...steps[directIndex], status };
        continue;
      }
    }

    const queue = pendingByTool.get(toolName);
    if (!queue || queue.length === 0) {
      continue;
    }

    // Fallback for results without request IDs: consume the oldest pending step with the same tool.
    while (queue.length > 0) {
      const pendingIndex = queue.shift();
      if (pendingIndex === undefined) {
        break;
      }
      if (steps[pendingIndex]?.status === "running") {
        steps[pendingIndex] = { ...steps[pendingIndex], status };
        break;
      }
    }
  }

  return steps;
}

export type MessageTurn = {
  id: string;
  userMessage: EventRecord;
  assistantMessage?: EventRecord;
  toolEvents: EventRecord[];
  steps: StepItem[];
};

// Group events into message turns
export function groupEventsIntoTurns(events: EventRecord[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let currentTurn: MessageTurn | null = null;

  for (const event of events) {
    if (isUserMessage(event)) {
      // Start a new turn
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        id: event._id,
        userMessage: event,
        toolEvents: [],
        steps: [],
      };
    } else if (isAssistantMessage(event)) {
      if (currentTurn) {
        // Attach to existing turn
        currentTurn.assistantMessage = event;
      } else {
        // Standalone assistant message (e.g., welcome message)
        // Create a synthetic turn with an empty user message
        turns.push({
          id: event._id,
          userMessage: { _id: `synthetic-${event._id}`, timestamp: event.timestamp, type: "user_message", payload: { text: "" } },
          assistantMessage: event,
          toolEvents: [],
          steps: [],
        });
      }
    } else if (currentTurn) {
      if (isToolRequest(event) || isToolResult(event)) {
        currentTurn.toolEvents.push(event);
      }
    }
  }

  // Push the last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  // Compute steps for each turn
  for (const turn of turns) {
    turn.steps = extractStepsFromEvents(turn.toolEvents);
  }

  return turns;
}

// Get the currently running tool name
export function getCurrentRunningTool(events: EventRecord[]): string | undefined {
  const steps = extractStepsFromEvents(events);
  const running = steps.find((s) => s.status === "running");
  return running?.tool;
}

// Extract tasks from events
export function extractTasksFromEvents(events: EventRecord[]): TaskItem[] {
  const startedEvents = events.filter(isTaskStarted);
  const completedEvents = events.filter(isTaskCompleted);
  const failedEvents = events.filter(isTaskFailed);
  const progressEvents = events.filter(isTaskProgress);

  // Build maps of taskId -> completion/failure events
  const completedByTaskId = new Map<string, EventRecord & { payload: TaskCompletedPayload }>();
  for (const event of completedEvents) {
    completedByTaskId.set(event.payload.taskId, event);
  }

  const failedByTaskId = new Map<string, EventRecord & { payload: TaskFailedPayload }>();
  for (const event of failedEvents) {
    failedByTaskId.set(event.payload.taskId, event);
  }

  // Build map of taskId -> latest progress status text
  const latestProgressByTaskId = new Map<string, string>();
  for (const event of progressEvents) {
    // Later events overwrite earlier ones — last one wins
    latestProgressByTaskId.set(event.payload.taskId, event.payload.statusText);
  }

  return startedEvents.map((event) => {
    const taskId = event.payload.taskId;
    let status: TaskItem["status"] = "running";

    if (completedByTaskId.has(taskId)) {
      status = "completed";
    } else if (failedByTaskId.has(taskId)) {
      status = "error";
    }

    return {
      id: taskId,
      description: event.payload.description,
      agentType: event.payload.agentType,
      status,
      parentTaskId: event.payload.parentTaskId,
      statusText: latestProgressByTaskId.get(taskId),
    };
  });
}

// Get currently running tasks
export function getRunningTasks(events: EventRecord[]): TaskItem[] {
  const tasks = extractTasksFromEvents(events);
  return tasks.filter((t) => t.status === "running");
}


