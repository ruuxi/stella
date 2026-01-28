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

// Message payload structure
export type MessagePayload = {
  text?: string;
  content?: string;
  role?: string;
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

// Extract steps from events
export function extractStepsFromEvents(events: EventRecord[]): StepItem[] {
  const requests = events.filter(isToolRequest);
  const results = new Map<string, EventRecord & { payload: ToolResultPayload }>();

  for (const event of events) {
    if (isToolResult(event) && event.requestId) {
      results.set(event.requestId, event);
    }
  }

  return requests.map((req) => {
    const requestId = req.requestId || req._id;
    const result = results.get(requestId);

    let status: StepItem["status"] = "running";
    if (result) {
      status = result.payload.error ? "error" : "completed";
    }

    return {
      id: requestId,
      tool: req.payload.toolName,
      title: extractToolTitle(req),
      status,
    };
  });
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
    } else if (currentTurn) {
      if (isAssistantMessage(event)) {
        currentTurn.assistantMessage = event;
      } else if (isToolRequest(event) || isToolResult(event)) {
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

// Main hook to fetch conversation events
export const useConversationEvents = (conversationId?: string) => {
  const result = useQuery(
    api.events.listEvents,
    conversationId
      ? { conversationId, paginationOpts: { cursor: null, numItems: 200 } }
      : "skip"
  ) as { page: EventRecord[] } | undefined;

  const events = result?.page ?? [];
  return [...events].reverse();
};

// Hook to extract steps from events
export const useStepsFromEvents = (events: EventRecord[]): StepItem[] => {
  return useMemo(() => extractStepsFromEvents(events), [events]);
};

// Hook to group events into message turns
export const useMessageTurns = (events: EventRecord[]): MessageTurn[] => {
  return useMemo(() => groupEventsIntoTurns(events), [events]);
};
