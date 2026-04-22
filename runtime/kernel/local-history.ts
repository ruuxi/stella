import { formatTimestampForHistory, TEN_MINUTES_MS } from "./message-timestamp.js";

// Internal sub-agent management tool names. Tool calls/results for these are
// hidden from the orchestrator's local history because they're already
// reflected by the dedicated `task_*` lifecycle events.
const INTERNAL_TASK_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "pause_agent",
]);

export type LocalContextEvent = {
  _id: string;
  timestamp: number;
  type: string;
  payload?: unknown;
  requestId?: string;
};

export type LocalHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export const LOCAL_CONTEXT_EVENT_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_request",
  "tool_result",
  "agent_started",
  "agent_completed",
  "agent_failed",
  "agent_canceled",
  "microcompact_boundary",
]);

type MicrocompactTrigger = "auto" | "manual";

type MicrocompactBoundaryPayload = {
  trigger: MicrocompactTrigger;
  preTokens: number;
  tokensSaved: number;
  compactedToolIds: string[];
  clearedAttachmentUUIDs: string[];
};

type HistoryBuildOptions = {
  microcompact?: {
    enabled?: boolean;
    trigger?: MicrocompactTrigger;
    keepTokens?: number;
    warningThresholdTokens?: number;
    isAboveWarningThreshold?: boolean;
  };
  timezone?: string;
};

type HistoryBuildResult = {
  messages: LocalHistoryMessage[];
  microcompactBoundary?: MicrocompactBoundaryPayload;
};

const MIN_EVENT_TOKENS = 8;
const MAX_TEXT_CHARS = 30_000;
const MAX_JSON_CHARS = 12_000;
const MICROCOMPACT_MIN_SAVED_TOKENS = 20_000;
const MICROCOMPACT_DEFAULT_KEEP_TOKENS = 40_000;
const MICROCOMPACT_PROTECT_RECENT_RESULTS = 3;
const MICROCOMPACT_ATTACHMENT_TOKENS = 2_000;
const MICROCOMPACT_SENTINEL_OPEN = "<microcompact_trimmed>";
const MICROCOMPACT_SENTINEL_CLOSE = "</microcompact_trimmed>";
const MICROCOMPACT_SENTINEL_TEXT =
  "Tool result compacted to save context. Re-run the tool if you need the full output.";
const MICROCOMPACT_TRIMMED_RESULT_TOKENS = Math.max(
  8,
  Math.ceil(
    `${MICROCOMPACT_SENTINEL_OPEN}${MICROCOMPACT_SENTINEL_TEXT}${MICROCOMPACT_SENTINEL_CLOSE}`.length / 4,
  ),
);

const MICROCOMPACT_ELIGIBLE_TOOLS = new Set([
  "exec_command",
  "write_stdin",
  "apply_patch",
  "web",
  "RequestCredential",
  "view_image",
  "image_gen",
  "Read",
  "Grep",
  "Bash",
  "ListFiles",
  "Write",
  "Edit",
  "ShellStatus",
]);

type PendingToolCall = {
  requestId?: string;
  toolName: string;
};

type TimestampState = {
  prevDate?: string;
  timezone?: string;
  prevUserTs?: number;
};

type MicrocompactState = {
  compactedToolIds: Set<string>;
  clearedAttachmentUUIDs: Set<string>;
};

type MicrocompactPlan = {
  compactedToolIds: Set<string>;
  clearedAttachmentUUIDs: Set<string>;
  newlyCompactedToolIds: string[];
  newlyClearedAttachmentUUIDs: string[];
  trigger: MicrocompactTrigger;
  preTokens: number;
  tokensSaved: number;
};

type ToolResultCandidate = {
  requestId: string;
  tokensSaved: number;
};

const truncateWithSuffix = (
  value: string,
  maxChars: number,
  suffix = "...(truncated)",
): string => (value.length <= maxChars ? value : `${value.slice(0, maxChars)}${suffix}`);

const stringifyBounded = (value: unknown, maxChars: number): string => {
  if (typeof value === "string") {
    return truncateWithSuffix(value.trim(), maxChars);
  }
  try {
    return truncateWithSuffix(JSON.stringify(value), maxChars);
  } catch {
    return truncateWithSuffix(String(value), maxChars);
  }
};

const asObject = <T = unknown>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, T>)
    : {};

const clampEventTokens = (tokens: number): number =>
  Math.max(MIN_EVENT_TOKENS, Math.floor(tokens));

const estimateTextTokens = (value: unknown): number => {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
};

const estimateJsonTokens = (value: unknown): number => {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return Math.ceil(String(value).length / 4);
  }
};

const estimateContextEventTokens = (event: {
  type: string;
  payload?: unknown;
  requestId?: string;
}): number => {
  const payload = asObject(event.payload);

  if (event.type === "microcompact_boundary") {
    const compactedCount = Array.isArray(payload.compactedToolIds)
      ? payload.compactedToolIds.length
      : 0;
    const clearedCount = Array.isArray(payload.clearedAttachmentUUIDs)
      ? payload.clearedAttachmentUUIDs.length
      : 0;
    return clampEventTokens(20 + compactedCount * 2 + clearedCount * 2);
  }

  if (event.type === "user_message" || event.type === "assistant_message") {
    return clampEventTokens(
      estimateTextTokens(payload.text) + (payload.usage ? estimateJsonTokens(payload.usage) : 0) + 8,
    );
  }

  if (
    event.type === "agent_started" ||
    event.type === "agent_completed" ||
    event.type === "agent_failed" ||
    event.type === "agent_canceled"
  ) {
    return clampEventTokens(
      estimateTextTokens(payload.description) +
        ("result" in payload ? estimateJsonTokens(payload.result) : 0) +
        estimateTextTokens(payload.error) +
        14,
    );
  }

  return clampEventTokens(estimateJsonTokens(payload) + 6);
};

const normalizeRequestId = (event: LocalContextEvent): string | undefined => {
  if (event.requestId && event.requestId.trim()) {
    return event.requestId;
  }
  const payload = asObject(event.payload);
  const fromPayload = typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  return fromPayload || undefined;
};

const normalizeToolName = (
  payload: Record<string, unknown>,
  fallbackToolName?: string,
): string => {
  const payloadToolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
  return payloadToolName || fallbackToolName || "unknown_tool";
};

const shouldHideToolFromHistory = (toolName: string): boolean =>
  INTERNAL_TASK_TOOL_NAMES.has(toolName);

const formatTaskEvent = (
  eventType: string,
  payload: Record<string, unknown>,
): LocalHistoryMessage | null => {
  const agentId = typeof payload.agentId === "string" ? payload.agentId : undefined;
  switch (eventType) {
    case "agent_started": {
      const description =
        typeof payload.description === "string" ? payload.description : "Task started";
      const agentType =
        typeof payload.agentType === "string" ? payload.agentType : "unknown";
      const lines = [`[Task started] ${description} (agent: ${agentType})`];
      if (agentId) lines.push(`thread_id: ${agentId}`);
      return { role: "user", content: lines.join("\n") };
    }
    case "agent_completed": {
      const lines = ["[Task completed]"];
      if (agentId) lines.push(`thread_id: ${agentId}`);
      if (payload.result !== undefined) {
        lines.push(`result: ${stringifyBounded(payload.result, MAX_JSON_CHARS)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    case "agent_failed": {
      const lines = ["[Task failed]"];
      if (agentId) lines.push(`thread_id: ${agentId}`);
      if (payload.error !== undefined) {
        lines.push(`error: ${stringifyBounded(payload.error, MAX_TEXT_CHARS)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    case "agent_canceled": {
      const lines = ["[Task canceled]"];
      if (agentId) lines.push(`thread_id: ${agentId}`);
      if (payload.error !== undefined) {
        lines.push(`error: ${stringifyBounded(payload.error, MAX_TEXT_CHARS)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    default:
      return null;
  }
};

const microcompactTrimmedMessage = () =>
  `${MICROCOMPACT_SENTINEL_OPEN}${MICROCOMPACT_SENTINEL_TEXT}${MICROCOMPACT_SENTINEL_CLOSE}`;

const isTrimmedResultPayload = (value: unknown): boolean =>
  typeof value === "string" &&
  value.includes(MICROCOMPACT_SENTINEL_OPEN) &&
  value.includes(MICROCOMPACT_SENTINEL_CLOSE);

const collectAttachmentUUIDs = (event: LocalContextEvent): string[] => {
  const payload = asObject(event.payload);
  const attachments = Array.isArray(payload.attachments)
    ? (payload.attachments as Array<unknown>)
    : [];
  const out: string[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = asObject(attachments[index]);
    const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
    const uuid = id || `${event._id}:attachment:${index}`;
    if (uuid) out.push(uuid);
  }
  return out;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const replayMicrocompactState = (events: LocalContextEvent[]): MicrocompactState => {
  const compactedToolIds = new Set<string>();
  const clearedAttachmentUUIDs = new Set<string>();
  for (const event of events) {
    if (event.type !== "microcompact_boundary") continue;
    const payload = asObject(event.payload);
    for (const id of asStringArray(payload.compactedToolIds)) {
      compactedToolIds.add(id);
    }
    for (const id of asStringArray(payload.clearedAttachmentUUIDs)) {
      clearedAttachmentUUIDs.add(id);
    }
  }
  return { compactedToolIds, clearedAttachmentUUIDs };
};

const estimateEventTokensForMicrocompact = (
  event: LocalContextEvent,
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let estimated = estimateContextEventTokens(event);
  if (event.type === "tool_result") {
    const requestId = normalizeRequestId(event);
    if (requestId && compactedToolIds.has(requestId)) {
      estimated = MICROCOMPACT_TRIMMED_RESULT_TOKENS;
    }
  }
  if (event.type === "user_message") {
    const attachmentUUIDs = collectAttachmentUUIDs(event);
    let uncleared = 0;
    for (const uuid of attachmentUUIDs) {
      if (!clearedAttachmentUUIDs.has(uuid)) uncleared += 1;
    }
    estimated += uncleared * MICROCOMPACT_ATTACHMENT_TOKENS;
  }
  return Math.max(1, Math.floor(estimated));
};

const estimateTotalTokensForMicrocompact = (
  events: LocalContextEvent[],
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let total = 0;
  for (const event of events) {
    total += estimateEventTokensForMicrocompact(
      event,
      compactedToolIds,
      clearedAttachmentUUIDs,
    );
  }
  return total;
};

const collectToolResultCandidates = (
  events: LocalContextEvent[],
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): ToolResultCandidate[] => {
  const requestToolName = new Map<string, string>();
  const candidates: ToolResultCandidate[] = [];
  for (const event of events) {
    if (event.type === "tool_request") {
      const requestId = normalizeRequestId(event);
      if (!requestId) continue;
      const payload = asObject(event.payload);
      requestToolName.set(requestId, normalizeToolName(payload));
      continue;
    }
    if (event.type !== "tool_result") continue;
    const requestId = normalizeRequestId(event);
    if (!requestId || compactedToolIds.has(requestId)) continue;
    const payload = asObject(event.payload);
    if (typeof payload.error === "string" && payload.error.trim()) continue;
    if (isTrimmedResultPayload(payload.result)) {
      compactedToolIds.add(requestId);
      continue;
    }
    const toolName = normalizeToolName(payload, requestToolName.get(requestId)).trim();
    if (!MICROCOMPACT_ELIGIBLE_TOOLS.has(toolName)) continue;
    const rawTokens = estimateEventTokensForMicrocompact(
      event,
      compactedToolIds,
      clearedAttachmentUUIDs,
    );
    const tokensSaved = Math.max(0, rawTokens - MICROCOMPACT_TRIMMED_RESULT_TOKENS);
    if (tokensSaved > 0) {
      candidates.push({ requestId, tokensSaved });
    }
  }
  return candidates;
};

const collectAttachmentCandidates = (
  events: LocalContextEvent[],
  clearedAttachmentUUIDs: Set<string>,
): string[] => {
  const candidates: string[] = [];
  let seenAssistantReply = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "assistant_message") {
      seenAssistantReply = true;
      continue;
    }
    if (!seenAssistantReply || event.type !== "user_message") {
      continue;
    }
    for (const uuid of collectAttachmentUUIDs(event)) {
      if (!clearedAttachmentUUIDs.has(uuid)) {
        candidates.push(uuid);
      }
    }
  }
  candidates.reverse();
  return candidates;
};

const buildMicrocompactPlan = (
  events: LocalContextEvent[],
  options: HistoryBuildOptions["microcompact"],
): MicrocompactPlan => {
  const state = replayMicrocompactState(events);
  const trigger = options?.trigger ?? "auto";
  const preTokens = estimateTotalTokensForMicrocompact(
    events,
    state.compactedToolIds,
    state.clearedAttachmentUUIDs,
  );

  const keepTokens = Math.max(
    1,
    Math.floor(options?.keepTokens ?? MICROCOMPACT_DEFAULT_KEEP_TOKENS),
  );
  const candidates = collectToolResultCandidates(
    events,
    state.compactedToolIds,
    state.clearedAttachmentUUIDs,
  );
  const protectedIds = new Set(
    candidates.slice(-MICROCOMPACT_PROTECT_RECENT_RESULTS).map((entry) => entry.requestId),
  );

  const newlyCompactedToolIds: string[] = [];
  let plannedSavings = 0;
  for (const candidate of candidates) {
    if (protectedIds.has(candidate.requestId)) continue;
    if (preTokens - plannedSavings <= keepTokens) break;
    newlyCompactedToolIds.push(candidate.requestId);
    plannedSavings += candidate.tokensSaved;
  }

  const newlyClearedAttachmentUUIDs: string[] = [];
  for (const uuid of collectAttachmentCandidates(events, state.clearedAttachmentUUIDs)) {
    if (preTokens - plannedSavings <= keepTokens) break;
    newlyClearedAttachmentUUIDs.push(uuid);
    plannedSavings += MICROCOMPACT_ATTACHMENT_TOKENS;
  }

  const warningThresholdTokens =
    typeof options?.warningThresholdTokens === "number"
      ? Math.max(1, Math.floor(options.warningThresholdTokens))
      : undefined;
  const isAboveWarningThreshold =
    options?.isAboveWarningThreshold ??
    (warningThresholdTokens !== undefined ? preTokens >= warningThresholdTokens : false);

  if (
    trigger === "auto" &&
    (!isAboveWarningThreshold || plannedSavings < MICROCOMPACT_MIN_SAVED_TOKENS)
  ) {
    return {
      compactedToolIds: state.compactedToolIds,
      clearedAttachmentUUIDs: state.clearedAttachmentUUIDs,
      newlyCompactedToolIds: [],
      newlyClearedAttachmentUUIDs: [],
      trigger,
      preTokens,
      tokensSaved: 0,
    };
  }

  const compactedToolIds = new Set(state.compactedToolIds);
  for (const requestId of newlyCompactedToolIds) {
    compactedToolIds.add(requestId);
  }

  const clearedAttachmentUUIDs = new Set(state.clearedAttachmentUUIDs);
  for (const uuid of newlyClearedAttachmentUUIDs) {
    clearedAttachmentUUIDs.add(uuid);
  }

  const postTokens = estimateTotalTokensForMicrocompact(
    events,
    compactedToolIds,
    clearedAttachmentUUIDs,
  );

  return {
    compactedToolIds,
    clearedAttachmentUUIDs,
    newlyCompactedToolIds,
    newlyClearedAttachmentUUIDs,
    trigger,
    preTokens,
    tokensSaved: Math.max(0, preTokens - postTokens),
  };
};


const formatTextEvent = (
  event: LocalContextEvent,
  tsState: TimestampState,
): LocalHistoryMessage | null => {
  const payload = asObject(event.payload);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  const isAssistant = event.type === "assistant_message";
  const skipTs = !isAssistant &&
    tsState.prevUserTs != null &&
    event.timestamp - tsState.prevUserTs < TEN_MINUTES_MS;
  if (!isAssistant) tsState.prevUserTs = event.timestamp;
  const { tag, dateStr } = formatTimestampForHistory(
    event.timestamp,
    tsState.prevDate,
    tsState.timezone,
  );
  tsState.prevDate = dateStr;
  const body = truncateWithSuffix(text, MAX_TEXT_CHARS);
  if (isAssistant) {
    return { role: "assistant", content: body };
  }
  return { role: "user", content: skipTs ? body : `${body}\n\n${tag}` };
};

const formatToolRequest = (event: LocalContextEvent): LocalHistoryMessage => {
  const payload = asObject(event.payload);
  const lines = [`[Tool call] ${normalizeToolName(payload)}`];
  const requestId = normalizeRequestId(event);
  if (requestId) lines.push(`request_id: ${requestId}`);
  lines.push(`args: ${stringifyBounded(payload.args ?? {}, MAX_JSON_CHARS)}`);
  return { role: "assistant", content: lines.join("\n") };
};

const formatToolResult = (
  event: LocalContextEvent,
  fallbackToolName: string | undefined,
  compactedToolIds: Set<string>,
): LocalHistoryMessage => {
  const payload = asObject(event.payload);
  const toolName = normalizeToolName(payload, fallbackToolName);
  const requestId = normalizeRequestId(event);
  const lines = [`[Tool result] ${toolName}`];
  if (requestId) lines.push(`request_id: ${requestId}`);
  if (requestId && compactedToolIds.has(requestId)) {
    lines.push(`result: ${microcompactTrimmedMessage()}`);
    return { role: "user", content: lines.join("\n") };
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    lines.push(`error: ${truncateWithSuffix(payload.error.trim(), MAX_TEXT_CHARS)}`);
  } else if ("result" in payload) {
    lines.push(`result: ${stringifyBounded(payload.result, MAX_JSON_CHARS)}`);
  }
  return { role: "user", content: lines.join("\n") };
};

const flushPendingToolCalls = (
  pendingById: Map<string, PendingToolCall>,
  pendingWithoutId: PendingToolCall[],
  out: LocalHistoryMessage[],
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

const eventsToHistoryMessages = (
  events: LocalContextEvent[],
  options: HistoryBuildOptions = {},
): HistoryBuildResult => {
  const out: LocalHistoryMessage[] = [];
  const pendingById = new Map<string, PendingToolCall>();
  const pendingWithoutId: PendingToolCall[] = [];
  const microcompactPlan = buildMicrocompactPlan(events, options.microcompact);
  const tsState: TimestampState = { timezone: options.timezone };

  for (const event of events) {
    if (
      event.type !== "tool_request" &&
      event.type !== "tool_result" &&
      (pendingById.size > 0 || pendingWithoutId.length > 0)
    ) {
      flushPendingToolCalls(pendingById, pendingWithoutId, out);
    }
    if (event.type === "microcompact_boundary") {
      continue;
    }
    if (event.type === "tool_request") {
      const payload = asObject(event.payload);
      const toolName = normalizeToolName(payload);
      if (shouldHideToolFromHistory(toolName)) {
        continue;
      }
      out.push(formatToolRequest(event));
      const pending: PendingToolCall = { toolName };
      const requestId = normalizeRequestId(event);
      if (requestId) {
        pending.requestId = requestId;
        pendingById.set(requestId, pending);
      } else {
        pendingWithoutId.push(pending);
      }
      continue;
    }
    if (event.type === "tool_result") {
      const payload = asObject(event.payload);
      const toolName = normalizeToolName(payload);
      if (shouldHideToolFromHistory(toolName)) {
        continue;
      }
      let fallbackName: string | undefined;
      const requestId = normalizeRequestId(event);
      if (requestId) {
        const pending = pendingById.get(requestId);
        fallbackName = pending?.toolName;
        pendingById.delete(requestId);
      } else if (pendingWithoutId.length > 0) {
        fallbackName = pendingWithoutId.shift()?.toolName;
      }
      out.push(formatToolResult(event, fallbackName, microcompactPlan.compactedToolIds));
      continue;
    }
    if (event.type === "user_message" || event.type === "assistant_message") {
      const message = formatTextEvent(event, tsState);
      if (message) out.push(message);
      continue;
    }

    const taskMessage = formatTaskEvent(event.type, asObject(event.payload));
    if (taskMessage) out.push(taskMessage);
  }

  if (pendingById.size > 0 || pendingWithoutId.length > 0) {
    flushPendingToolCalls(pendingById, pendingWithoutId, out);
  }

  const hasBoundary =
    microcompactPlan.newlyCompactedToolIds.length > 0 ||
    microcompactPlan.newlyClearedAttachmentUUIDs.length > 0;

  return {
    messages: out,
    ...(hasBoundary
      ? {
          microcompactBoundary: {
            trigger: microcompactPlan.trigger,
            preTokens: microcompactPlan.preTokens,
            tokensSaved: microcompactPlan.tokensSaved,
            compactedToolIds: microcompactPlan.newlyCompactedToolIds,
            clearedAttachmentUUIDs: microcompactPlan.newlyClearedAttachmentUUIDs,
          },
        }
      : {}),
  };
};

export const selectRecentByTokenBudget = <T>(args: {
  itemsNewestFirst: T[];
  maxTokens: number;
  maxItems?: number;
  estimateTokens: (item: T) => number;
}): T[] => {
  const safeMaxTokens = Math.max(1, Math.floor(args.maxTokens));
  const safeMaxItems =
    args.maxItems === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.floor(args.maxItems));
  const selected: T[] = [];
  let usedTokens = 0;
  for (const item of args.itemsNewestFirst) {
    if (selected.length >= safeMaxItems) break;
    const itemTokens = Math.max(1, Math.floor(args.estimateTokens(item)));
    if (selected.length > 0 && usedTokens + itemTokens > safeMaxTokens) {
      break;
    }
    selected.push(item);
    usedTokens += itemTokens;
  }
  return selected;
};

export const buildLocalHistoryFromEvents = (args: {
  events: LocalContextEvent[];
  maxTokens?: number;
  timezone?: string;
  warningThresholdTokens?: number;
}): LocalHistoryMessage[] => {
  const selected = selectRecentByTokenBudget({
    itemsNewestFirst: [...args.events].reverse(),
    maxTokens: args.maxTokens ?? 24_000,
    estimateTokens: (event) => estimateContextEventTokens(event),
  });
  const chronological = [...selected].reverse();
  return eventsToHistoryMessages(chronological, {
    timezone: args.timezone,
    microcompact: {
      trigger: "auto",
      warningThresholdTokens: args.warningThresholdTokens ?? 170_000,
    },
  }).messages;
};
