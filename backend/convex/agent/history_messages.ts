import type { Doc } from "../_generated/dataModel";

type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
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

const formatEvent = (event: Doc<"events">): HistoryMessage | null => {
  const payload = asObject(event.payload);

  if (event.type === "user_message" || event.type === "assistant_message") {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return null;
    return {
      role: event.type === "assistant_message" ? "assistant" : "user",
      content: ellipsize(text, MAX_TEXT_CHARS),
    };
  }

  if (event.type === "tool_request") {
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
  }

  if (event.type === "tool_result") {
    const toolName =
      typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
    const lines = [`[Tool result] ${toolName}`];
    if (event.requestId) lines.push(`request_id: ${event.requestId}`);
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      lines.push(`error: ${ellipsize(payload.error.trim(), MAX_TEXT_CHARS)}`);
    } else if ("result" in payload) {
      lines.push(`result: ${stringifyValue(payload.result)}`);
    }
    return { role: "user", content: lines.join("\n") };
  }

  return formatTaskEvent(event.type, payload);
};

export const eventsToHistoryMessages = (
  events: Doc<"events">[],
): HistoryMessage[] =>
  events
    .map((event) => formatEvent(event))
    .filter((message): message is HistoryMessage => Boolean(message));

