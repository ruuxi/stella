/**
 * History message builder — converts event rows from SQLite to LLM-friendly messages.
 * Ported from backend/convex/agent/history_messages.ts + context_window.ts
 */

import { rawQuery } from "../db";

// ─── Types ───────────────────────────────────────────────────────────────────

type EventRow = {
  id: string;
  conversation_id: string;
  timestamp: number;
  type: string;
  payload: Record<string, unknown> | string;
  request_id?: string;
  device_id?: string;
};

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type PendingToolCall = {
  requestId?: string;
  toolName: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TEXT_CHARS = 30_000;
const MAX_JSON_CHARS = 12_000;
const MIN_EVENT_TOKENS = 8;
const MAX_EVENT_TOKENS = 8_000;

export const ORCHESTRATOR_HISTORY_MAX_TOKENS = 24_000;
export const SUBAGENT_HISTORY_MAX_TOKENS = 20_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ellipsize = (value: string, maxChars: number) =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...(truncated)`;

const asPayload = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return (value && typeof value === "object") ? value as Record<string, unknown> : {};
};

const stringifyValue = (value: unknown, maxChars = MAX_JSON_CHARS): string => {
  if (typeof value === "string") return ellipsize(value.trim(), maxChars);
  try { return ellipsize(JSON.stringify(value), maxChars); }
  catch { return ellipsize(String(value), maxChars); }
};

// ─── Token Estimation ────────────────────────────────────────────────────────

function estimateTextTokens(value: unknown): number {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : Math.ceil(trimmed.length / 4);
}

function estimateJsonTokens(value: unknown): number {
  try { return Math.ceil(JSON.stringify(value).length / 4); }
  catch { return Math.ceil(String(value).length / 4); }
}

function clampEventTokens(tokens: number): number {
  return Math.max(MIN_EVENT_TOKENS, Math.min(MAX_EVENT_TOKENS, Math.max(0, Math.floor(tokens))));
}

function estimateEventTokens(event: EventRow): number {
  const payload = asPayload(event.payload);

  if (event.type === "user_message" || event.type === "assistant_message") {
    return clampEventTokens(estimateTextTokens(payload.text) + 8);
  }
  if (event.type === "tool_request") {
    return clampEventTokens(estimateTextTokens(payload.toolName) + estimateJsonTokens(payload.args ?? {}) + 20);
  }
  if (event.type === "tool_result") {
    return clampEventTokens(
      estimateTextTokens(payload.toolName) +
      ("result" in payload ? estimateJsonTokens(payload.result) : 0) +
      estimateTextTokens(payload.error) + 20
    );
  }
  if (event.type === "task_started" || event.type === "task_completed" || event.type === "task_failed") {
    return clampEventTokens(
      estimateTextTokens(payload.description) +
      ("result" in payload ? estimateJsonTokens(payload.result) : 0) +
      estimateTextTokens(payload.error) + 14
    );
  }
  return clampEventTokens(estimateJsonTokens(payload) + 6);
}

// ─── Load Events by Token Budget ─────────────────────────────────────────────

export function loadRecentEvents(
  conversationId: string,
  maxTokens: number,
  beforeTimestamp?: number,
  excludeEventId?: string,
): EventRow[] {
  let sql = "SELECT * FROM events WHERE conversation_id = ?";
  const params: unknown[] = [conversationId];

  if (beforeTimestamp !== undefined) {
    sql += " AND timestamp <= ?";
    params.push(beforeTimestamp);
  }

  sql += " ORDER BY timestamp DESC LIMIT 500";
  const allEvents = rawQuery<EventRow>(sql, params);

  // Filter excluded event
  const filtered = excludeEventId
    ? allEvents.filter((e) => e.id !== excludeEventId)
    : allEvents;

  // Select by token budget (newest first)
  const selected: EventRow[] = [];
  let usedTokens = 0;

  for (const event of filtered) {
    const tokens = estimateEventTokens(event);
    if (selected.length > 0 && usedTokens + tokens > maxTokens) break;
    selected.push(event);
    usedTokens += tokens;
  }

  // Reverse to chronological order
  selected.reverse();
  return selected;
}

// ─── Convert Events to History Messages ──────────────────────────────────────

function formatToolRequest(event: EventRow): HistoryMessage {
  const payload = asPayload(event.payload);
  const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
  const toolArgs = payload.args ?? {};
  const agentType = typeof payload.agentType === "string" ? payload.agentType : undefined;
  const lines = [`[Tool call] ${toolName}${agentType ? ` (agent: ${agentType})` : ""}`];
  if (event.request_id) lines.push(`request_id: ${event.request_id}`);
  lines.push(`args: ${stringifyValue(toolArgs)}`);
  return { role: "assistant", content: lines.join("\n") };
}

function formatToolResult(event: EventRow, fallbackToolName?: string): HistoryMessage {
  const payload = asPayload(event.payload);
  const payloadToolName = typeof payload.toolName === "string" ? payload.toolName : "";
  const toolName = payloadToolName || fallbackToolName || "unknown_tool";
  const lines = [`[Tool result] ${toolName}`];
  if (event.request_id) lines.push(`request_id: ${event.request_id}`);
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    lines.push(`error: ${ellipsize(payload.error.trim(), MAX_TEXT_CHARS)}`);
  } else if ("result" in payload) {
    lines.push(`result: ${stringifyValue(payload.result)}`);
  }
  return { role: "user", content: lines.join("\n") };
}

function formatTaskEvent(eventType: string, payload: Record<string, unknown>): HistoryMessage | null {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
  if (eventType === "task_started") {
    const description = typeof payload.description === "string" ? payload.description : "Task started";
    const agentType = typeof payload.agentType === "string" ? payload.agentType : "unknown";
    const lines = [`[Task started] ${description} (agent: ${agentType})`];
    if (taskId) lines.push(`task_id: ${taskId}`);
    return { role: "user", content: lines.join("\n") };
  }
  if (eventType === "task_completed") {
    const lines = ["[Task completed]"];
    if (taskId) lines.push(`task_id: ${taskId}`);
    if (payload.result !== undefined) lines.push(`result: ${stringifyValue(payload.result)}`);
    return { role: "user", content: lines.join("\n") };
  }
  if (eventType === "task_failed") {
    const lines = ["[Task failed]"];
    if (taskId) lines.push(`task_id: ${taskId}`);
    if (payload.error !== undefined) lines.push(`error: ${stringifyValue(payload.error)}`);
    return { role: "user", content: lines.join("\n") };
  }
  return null;
}

function flushPendingToolCalls(
  pendingById: Map<string, PendingToolCall>,
  pendingWithoutId: PendingToolCall[],
  out: HistoryMessage[],
) {
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
}

export function eventsToHistoryMessages(events: EventRow[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  const pendingById = new Map<string, PendingToolCall>();
  const pendingWithoutId: PendingToolCall[] = [];

  for (const event of events) {
    const payload = asPayload(event.payload);

    if (
      event.type !== "tool_request" &&
      event.type !== "tool_result" &&
      (pendingById.size > 0 || pendingWithoutId.length > 0)
    ) {
      flushPendingToolCalls(pendingById, pendingWithoutId, out);
    }

    if (event.type === "tool_request") {
      out.push(formatToolRequest(event));
      const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown_tool";
      const pending: PendingToolCall = { toolName };
      if (event.request_id) {
        pending.requestId = event.request_id;
        pendingById.set(event.request_id, pending);
      } else {
        pendingWithoutId.push(pending);
      }
      continue;
    }

    if (event.type === "tool_result") {
      let fallbackName: string | undefined;
      if (event.request_id) {
        const pending = pendingById.get(event.request_id);
        fallbackName = pending?.toolName;
        pendingById.delete(event.request_id);
      } else if (pendingWithoutId.length > 0) {
        fallbackName = pendingWithoutId.shift()?.toolName;
      }
      out.push(formatToolResult(event, fallbackName));
      continue;
    }

    if (event.type === "user_message" || event.type === "assistant_message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text) {
        out.push({
          role: event.type === "assistant_message" ? "assistant" : "user",
          content: ellipsize(text, MAX_TEXT_CHARS),
        });
      }
      continue;
    }

    const taskMessage = formatTaskEvent(event.type, payload);
    if (taskMessage) out.push(taskMessage);
  }

  if (pendingById.size > 0 || pendingWithoutId.length > 0) {
    flushPendingToolCalls(pendingById, pendingWithoutId, out);
  }

  return out;
}
