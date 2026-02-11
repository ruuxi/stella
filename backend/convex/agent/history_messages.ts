import type { Doc } from "../_generated/dataModel";

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type PendingToolCall = {
  requestId?: string;
  toolName: string;
};

const MAX_TEXT_CHARS = 4000;
const MAX_JSON_CHARS = 1200;

const ellipsize = (value: string, maxChars: number) =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...(truncated)`;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const stringifyValue = (value: unknown, maxChars = MAX_JSON_CHARS): string => {
  if (typeof value === "string") {
    return ellipsize(value.trim(), maxChars);
  }
  try {
    return ellipsize(JSON.stringify(value), maxChars);
  } catch {
    return ellipsize(String(value), maxChars);
  }
};

const formatTaskEvent = (
  eventType: string,
  payload: Record<string, unknown>,
): HistoryMessage | null => {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
  if (eventType === "task_started") {
    const description =
      typeof payload.description === "string" ? payload.description : "Task started";
    const agentType =
      typeof payload.agentType === "string" ? payload.agentType : "unknown";
    const lines = [`[Task started] ${description} (agent: ${agentType})`];
    if (taskId) lines.push(`task_id: ${taskId}`);
    return { role: "user", content: lines.join("\n") };
  }
  if (eventType === "task_completed") {
    const lines = ["[Task completed]"];
    if (taskId) lines.push(`task_id: ${taskId}`);
    if (payload.result !== undefined) {
      lines.push(`result: ${stringifyValue(payload.result)}`);
    }
    return { role: "user", content: lines.join("\n") };
  }
  if (eventType === "task_failed") {
    const lines = ["[Task failed]"];
    if (taskId) lines.push(`task_id: ${taskId}`);
    if (payload.error !== undefined) {
      lines.push(`error: ${stringifyValue(payload.error)}`);
    }
    return { role: "user", content: lines.join("\n") };
  }
  return null;
};

const formatToolRequest = (event: Doc<"events">): HistoryMessage => {
  const payload = asObject(event.payload);
  const toolName =
    typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
  const toolArgs = payload.args ?? {};
  const agentType =
    typeof payload.agentType === "string" ? payload.agentType : undefined;
  const lines = [
    `[Tool call] ${toolName}${agentType ? ` (agent: ${agentType})` : ""}`,
  ];
  if (event.requestId) lines.push(`request_id: ${event.requestId}`);
  lines.push(`args: ${stringifyValue(toolArgs)}`);
  return { role: "assistant", content: lines.join("\n") };
};

const formatToolResult = (
  event: Doc<"events">,
  fallbackToolName?: string,
): HistoryMessage => {
  const payload = asObject(event.payload);
  const payloadToolName =
    typeof payload.toolName === "string" ? payload.toolName : "";
  const toolName = payloadToolName || fallbackToolName || "unknown_tool";
  const lines = [`[Tool result] ${toolName}`];
  if (event.requestId) lines.push(`request_id: ${event.requestId}`);
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    lines.push(`error: ${ellipsize(payload.error.trim(), MAX_TEXT_CHARS)}`);
  } else if ("result" in payload) {
    lines.push(`result: ${stringifyValue(payload.result)}`);
  }
  return { role: "user", content: lines.join("\n") };
};

const flushPendingToolCalls = (
  pendingById: Map<string, PendingToolCall>,
  pendingWithoutId: PendingToolCall[],
  out: HistoryMessage[],
) => {
  for (const pending of pendingById.values()) {
    const lines = [`[Tool result] ${pending.toolName}`];
    if (pending.requestId) lines.push(`request_id: ${pending.requestId}`);
    lines.push("error: No result provided");
    out.push({ role: "user", content: lines.join("\n") });
  }
  pendingById.clear();
  for (const pending of pendingWithoutId) {
    out.push({
      role: "user",
      content: `[Tool result] ${pending.toolName}\nerror: No result provided`,
    });
  }
  pendingWithoutId.length = 0;
};

const formatTextEvent = (event: Doc<"events">): HistoryMessage | null => {
  const payload = asObject(event.payload);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  return {
    role: event.type === "assistant_message" ? "assistant" : "user",
    content: ellipsize(text, MAX_TEXT_CHARS),
  };
};

export const eventsToHistoryMessages = (
  events: Doc<"events">[],
): HistoryMessage[] => {
  const out: HistoryMessage[] = [];
  const pendingById = new Map<string, PendingToolCall>();
  const pendingWithoutId: PendingToolCall[] = [];

  for (const event of events) {
    // Any non-tool event boundary ends the prior pending tool chain.
    if (
      event.type !== "tool_request" &&
      event.type !== "tool_result" &&
      (pendingById.size > 0 || pendingWithoutId.length > 0)
    ) {
      flushPendingToolCalls(pendingById, pendingWithoutId, out);
    }

    if (event.type === "tool_request") {
      const toolMessage = formatToolRequest(event);
      out.push(toolMessage);
      const payload = asObject(event.payload);
      const toolName =
        typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
      const pending: PendingToolCall = { toolName };
      if (event.requestId) {
        pending.requestId = event.requestId;
        pendingById.set(event.requestId, pending);
      } else {
        pendingWithoutId.push(pending);
      }
      continue;
    }

    if (event.type === "tool_result") {
      let fallbackName: string | undefined;
      if (event.requestId) {
        const pending = pendingById.get(event.requestId);
        fallbackName = pending?.toolName;
        pendingById.delete(event.requestId);
      } else if (pendingWithoutId.length > 0) {
        fallbackName = pendingWithoutId.shift()?.toolName;
      }
      out.push(formatToolResult(event, fallbackName));
      continue;
    }

    if (event.type === "user_message" || event.type === "assistant_message") {
      const textMessage = formatTextEvent(event);
      if (textMessage) out.push(textMessage);
      continue;
    }

    const taskMessage = formatTaskEvent(event.type, asObject(event.payload));
    if (taskMessage) out.push(taskMessage);
  }

  if (pendingById.size > 0 || pendingWithoutId.length > 0) {
    flushPendingToolCalls(pendingById, pendingWithoutId, out);
  }

  return out;
};
