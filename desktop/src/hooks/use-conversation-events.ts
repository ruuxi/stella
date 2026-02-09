import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../convex/api";
import type { StepItem } from "../components/steps-container";

// Base event record from Convex
export type EventRecord = {
  _id: string;
  timestamp: number;
  type: string;
  deviceId?: string;
  requestId?: string;
  targetDeviceId?: string;
  payload?: Record<string, unknown>;
};

// Tool request payload structure
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
  error?: string;
  requestId?: string;
};

// Attachment structure
export type Attachment = {
  id?: string;
  url?: string;
  mimeType?: string;
  name?: string;
};

// Message payload structure
export type MessagePayload = {
  text?: string;
  content?: string;
  message?: string;
  role?: string;
  attachments?: Attachment[];
  mode?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
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

// Task item for UI display
export type TaskItem = {
  id: string;
  description: string;
  agentType: string;
  status: "running" | "completed" | "error";
  parentTaskId?: string;
};

// Type guards
export function isToolRequest(
  event: EventRecord
): event is EventRecord & { payload: ToolRequestPayload } {
  return (
    event.type === "tool_request" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "toolName" in event.payload
  );
}

export function isToolResult(
  event: EventRecord
): event is EventRecord & { payload: ToolResultPayload } {
  return (
    event.type === "tool_result" &&
    typeof event.payload === "object" &&
    event.payload !== null
  );
}

export function isUserMessage(event: EventRecord): boolean {
  return event.type === "user_message";
}

export function isAssistantMessage(event: EventRecord): boolean {
  return event.type === "assistant_message";
}

export function isTaskStarted(
  event: EventRecord
): event is EventRecord & { payload: TaskStartedPayload } {
  return (
    event.type === "task_started" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "taskId" in event.payload
  );
}

export function isTaskCompleted(
  event: EventRecord
): event is EventRecord & { payload: TaskCompletedPayload } {
  return (
    event.type === "task_completed" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "taskId" in event.payload
  );
}

export function isTaskFailed(
  event: EventRecord
): event is EventRecord & { payload: TaskFailedPayload } {
  return (
    event.type === "task_failed" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "taskId" in event.payload
  );
}

// Extract a human-readable title from a tool request
export function extractToolTitle(event: EventRecord): string {
  if (!isToolRequest(event)) return "";

  const { toolName, args } = event.payload;

  switch (toolName.toLowerCase()) {
    case "read":
      return args?.path ? String(args.path).split("/").pop() || "file" : "Reading file";
    case "write":
      return args?.path ? String(args.path).split("/").pop() || "file" : "Writing file";
    case "edit":
      return args?.path ? String(args.path).split("/").pop() || "file" : "Editing file";
    case "grep":
      return args?.pattern ? `"${String(args.pattern).slice(0, 30)}"` : "Searching";
    case "glob":
      return args?.pattern ? String(args.pattern) : "Finding files";
    case "bash":
      return args?.command
        ? String(args.command).slice(0, 40) + (String(args.command).length > 40 ? "..." : "")
        : "Running command";
    case "webfetch":
      return args?.url ? new URL(String(args.url)).hostname : "Fetching";
    case "task":
      return args?.description ? String(args.description).slice(0, 40) : "Delegating";
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

// Extract steps from events
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

// Message turn grouping
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

  // Build maps of taskId -> completion/failure events
  const completedByTaskId = new Map<string, EventRecord & { payload: TaskCompletedPayload }>();
  for (const event of completedEvents) {
    completedByTaskId.set(event.payload.taskId, event);
  }

  const failedByTaskId = new Map<string, EventRecord & { payload: TaskFailedPayload }>();
  for (const event of failedEvents) {
    failedByTaskId.set(event.payload.taskId, event);
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
    };
  });
}

// Get currently running tasks
export function getRunningTasks(events: EventRecord[]): TaskItem[] {
  const tasks = extractTasksFromEvents(events);
  return tasks.filter((t) => t.status === "running");
}

// Main hook to fetch conversation events
export const useConversationEvents = (conversationId?: string) => {
  const result = useQuery(
    api.events.listEvents,
    conversationId
      ? { conversationId, paginationOpts: { cursor: null, numItems: 200 } }
      : "skip"
  ) as { page: EventRecord[] } | undefined;

  return useMemo(() => {
    const events = result?.page ?? [];
    return [...events].reverse();
  }, [result?.page]);
};

// Hook to extract steps from events
export const useStepsFromEvents = (events: EventRecord[]): StepItem[] => {
  return useMemo(() => extractStepsFromEvents(events), [events]);
};

// Hook to group events into message turns
export const useMessageTurns = (events: EventRecord[]): MessageTurn[] => {
  return useMemo(() => groupEventsIntoTurns(events), [events]);
};
