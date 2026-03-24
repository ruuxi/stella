import { asObjectRecord } from "./object-record";
import { stringifyBounded, truncateWithSuffix } from "./text-utils";
import { estimateContextEventTokens } from "./context-window";

/**
 * Generic context event shape — compatible with both Convex Doc<"events">
 * and the frontend EventRecord type.
 */
export type ContextEvent = {
  _id: string;
  timestamp: number;
  type: string;
  payload?: unknown;
  requestId?: string;
};

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MicrocompactTrigger = "auto" | "manual";

export type MicrocompactBoundaryPayload = {
  trigger: MicrocompactTrigger;
  preTokens: number;
  tokensSaved: number;
  compactedToolIds: string[];
  clearedAttachmentUUIDs: string[];
};

export type HistoryBuildOptions = {
  microcompact?: {
    enabled?: boolean;
    trigger?: MicrocompactTrigger;
    keepTokens?: number;
    warningThresholdTokens?: number;
    isAboveWarningThreshold?: boolean;
  };
  timezone?: string;
};

export type HistoryBuildResult = {
  messages: HistoryMessage[];
  microcompactBoundary?: MicrocompactBoundaryPayload;
};

type PendingToolCall = {
  requestId?: string;
  toolName: string;
};

const MAX_TEXT_CHARS = 30_000;
const MAX_JSON_CHARS = 12_000;

const MICROCOMPACT_MIN_SAVED_TOKENS = 20_000;
const MICROCOMPACT_DEFAULT_KEEP_TOKENS = 40_000;
const MICROCOMPACT_PROTECT_RECENT_RESULTS = 3;
const MICROCOMPACT_ATTACHMENT_TOKENS = 2_000;
const MICROCOMPACT_SENTINEL_OPEN = "<microcompact_trimmed>";
const MICROCOMPACT_SENTINEL_CLOSE = "</microcompact_trimmed>";
const MICROCOMPACT_SENTINEL_TEXT =
  "Tool result compacted to save context. Re-run the tool (for example Read) if you need the full output.";
const MICROCOMPACT_TRIMMED_RESULT_TOKENS = Math.max(
  8,
  Math.ceil(
    `${MICROCOMPACT_SENTINEL_OPEN}${MICROCOMPACT_SENTINEL_TEXT}${MICROCOMPACT_SENTINEL_CLOSE}`.length /
      4,
  ),
);

const MICROCOMPACT_ELIGIBLE_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "ListFiles",
  "Write",
  "Edit",
  "ShellStatus",
]);


/** Browser-safe env var access (works in Node, Convex, and browser). */
const getEnvVar = (key: string): string | undefined => {
  const processEnv = typeof process !== "undefined" ? process.env : undefined;
  return processEnv?.[key];
};

const normalizeRequestId = (event: ContextEvent): string | undefined => {
  if (event.requestId && event.requestId.trim().length > 0) {
    return event.requestId;
  }
  const payload = asObjectRecord(event.payload);
  const fromPayload =
    typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  return fromPayload.length > 0 ? fromPayload : undefined;
};

const normalizeToolName = (
  payload: Record<string, unknown>,
  fallbackToolName?: string,
): string => {
  const payloadToolName =
    typeof payload.toolName === "string" ? payload.toolName.trim() : "";
  return payloadToolName || fallbackToolName || "unknown_tool";
};

const isMicrocompactDisabled = (enabledOverride?: boolean): boolean => {
  if (enabledOverride === false) return true;
  const envDisabled = String(getEnvVar("DISABLE_MICROCOMPACT") ?? "").toLowerCase();
  return envDisabled === "1" || envDisabled === "true";
};

const isEligibleToolName = (toolName: string): boolean =>
  MICROCOMPACT_ELIGIBLE_TOOLS.has(toolName);

const stringifyValue = (value: unknown, maxChars = MAX_JSON_CHARS): string =>
  stringifyBounded(value, maxChars);

const formatTaskEvent = (
  eventType: string,
  payload: Record<string, unknown>,
): HistoryMessage | null => {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
  switch (eventType) {
    case "task_started": {
      const description =
        typeof payload.description === "string" ? payload.description : "Task started";
      const agentType =
        typeof payload.agentType === "string" ? payload.agentType : "unknown";
      const lines = [`[Task started] ${description} (agent: ${agentType})`];
      if (taskId) lines.push(`thread_id: ${taskId}`);
      return { role: "user", content: lines.join("\n") };
    }
    case "task_completed": {
      const lines = ["[Task completed]"];
      if (taskId) lines.push(`thread_id: ${taskId}`);
      if (payload.result !== undefined) {
        lines.push(`result: ${stringifyValue(payload.result)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    case "task_failed": {
      const lines = ["[Task failed]"];
      if (taskId) lines.push(`thread_id: ${taskId}`);
      if (payload.error !== undefined) {
        lines.push(`error: ${stringifyValue(payload.error)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    case "task_canceled": {
      const lines = ["[Task canceled]"];
      if (taskId) lines.push(`thread_id: ${taskId}`);
      if (payload.error !== undefined) {
        lines.push(`error: ${stringifyValue(payload.error)}`);
      }
      return { role: "user", content: lines.join("\n") };
    }
    default:
      return null;
  }
};

const formatToolRequest = (event: ContextEvent): HistoryMessage => {
  const payload = asObjectRecord(event.payload);
  const toolName = normalizeToolName(payload);
  const toolArgs = payload.args ?? {};
  const agentType =
    typeof payload.agentType === "string" ? payload.agentType : undefined;
  const lines = [
    `[Tool call] ${toolName}${agentType ? ` (agent: ${agentType})` : ""}`,
  ];
  const requestId = normalizeRequestId(event);
  if (requestId) lines.push(`request_id: ${requestId}`);
  lines.push(`args: ${stringifyValue(toolArgs)}`);
  return { role: "assistant", content: lines.join("\n") };
};

const microcompactTrimmedMessage = () =>
  `${MICROCOMPACT_SENTINEL_OPEN}${MICROCOMPACT_SENTINEL_TEXT}${MICROCOMPACT_SENTINEL_CLOSE}`;

const isTrimmedResultPayload = (value: unknown): boolean =>
  typeof value === "string" &&
  value.includes(MICROCOMPACT_SENTINEL_OPEN) &&
  value.includes(MICROCOMPACT_SENTINEL_CLOSE);

const formatToolResult = (
  event: ContextEvent,
  fallbackToolName: string | undefined,
  compactedToolIds: Set<string>,
): HistoryMessage => {
  const payload = asObjectRecord(event.payload);
  const toolName = normalizeToolName(payload, fallbackToolName);
  const requestId = normalizeRequestId(event);
  const lines = [`[Tool result] ${toolName}`];
  if (requestId) lines.push(`request_id: ${requestId}`);

  if (requestId && compactedToolIds.has(requestId)) {
    lines.push(`result: ${microcompactTrimmedMessage()}`);
    return { role: "user", content: lines.join("\n") };
  }

  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    lines.push(`error: ${truncateWithSuffix(payload.error.trim(), MAX_TEXT_CHARS)}`);
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

/** Format a timestamp for message tagging. Includes date only if it differs from prevDate. */
export const formatMessageTimestamp = (
  timestamp: number,
  prevDate?: string,
  timezone?: string,
): { tag: string; dateStr: string } => {
  const tz = timezone ?? "UTC";
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const tag = prevDate && dateStr === prevDate
    ? `[${timeStr}]`
    : `[${timeStr}, ${dateStr}]`;
  return { tag, dateStr };
};

type TimestampState = { prevDate?: string; timezone?: string };

const formatTextEvent = (
  event: ContextEvent,
  tsState: TimestampState,
): HistoryMessage | null => {
  const payload = asObjectRecord(event.payload);
  const contextText =
    typeof payload.contextText === "string" ? payload.contextText.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const effectiveText = contextText || text;
  if (!effectiveText) return null;
  if (contextText) {
    return {
      role: event.type === "assistant_message" ? "assistant" : "user",
      content: truncateWithSuffix(effectiveText, MAX_TEXT_CHARS),
    };
  }
  if (!text) return null;
  const { tag, dateStr } = formatMessageTimestamp(
    event.timestamp,
    tsState.prevDate,
    tsState.timezone,
  );
  tsState.prevDate = dateStr;
  return {
    role: event.type === "assistant_message" ? "assistant" : "user",
    content: `${truncateWithSuffix(text, MAX_TEXT_CHARS)}\n\n${tag}`,
  };
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const collectAttachmentUUIDs = (event: ContextEvent): string[] => {
  const payload = asObjectRecord(event.payload);
  const attachments = Array.isArray(payload.attachments)
    ? (payload.attachments as Array<unknown>)
    : [];

  const out: string[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = asObjectRecord(attachments[index]);
    const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
    const uuid = id || `${event._id}:attachment:${index}`;
    if (uuid.length > 0) out.push(uuid);
  }
  return out;
};

type MicrocompactState = {
  compactedToolIds: Set<string>;
  clearedAttachmentUUIDs: Set<string>;
};

const replayMicrocompactState = (events: ContextEvent[]): MicrocompactState => {
  const compactedToolIds = new Set<string>();
  const clearedAttachmentUUIDs = new Set<string>();

  for (const event of events) {
    if (event.type !== "microcompact_boundary") continue;
    const payload = asObjectRecord(event.payload);
    const compacted = asStringArray(payload.compactedToolIds);
    const cleared = asStringArray(payload.clearedAttachmentUUIDs);
    for (const id of compacted) compactedToolIds.add(id);
    for (const uuid of cleared) clearedAttachmentUUIDs.add(uuid);
  }

  return { compactedToolIds, clearedAttachmentUUIDs };
};

const estimateEventTokensForMicrocompact = (
  event: ContextEvent,
  _index: number,
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let estimated = estimateContextEventTokens({
    type: event.type,
    payload: event.payload,
    requestId: event.requestId,
  });

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
  events: ContextEvent[],
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let total = 0;
  for (let i = 0; i < events.length; i += 1) {
    total += estimateEventTokensForMicrocompact(
      events[i]!,
      i,
      compactedToolIds,
      clearedAttachmentUUIDs,
    );
  }
  return total;
};

type ToolResultCandidate = {
  requestId: string;
  tokensSaved: number;
};

const collectToolResultCandidates = (
  events: ContextEvent[],
  compactedToolIds: Set<string>,
  clearedAttachmentUUIDs: Set<string>,
): ToolResultCandidate[] => {
  const requestToolName = new Map<string, string>();
  const candidates: ToolResultCandidate[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type === "tool_request") {
      const requestId = normalizeRequestId(event);
      if (!requestId) continue;
      const payload = asObjectRecord(event.payload);
      const toolName = normalizeToolName(payload).trim();
      if (toolName.length > 0) {
        requestToolName.set(requestId, toolName);
      }
      continue;
    }

    if (event.type !== "tool_result") continue;
    const requestId = normalizeRequestId(event);
    if (!requestId || compactedToolIds.has(requestId)) continue;

    const payload = asObjectRecord(event.payload);
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
      continue;
    }
    if (isTrimmedResultPayload(payload.result)) {
      compactedToolIds.add(requestId);
      continue;
    }

    const toolName = normalizeToolName(payload, requestToolName.get(requestId)).trim();
    if (!isEligibleToolName(toolName)) continue;

    const rawTokens = estimateEventTokensForMicrocompact(
      event,
      i,
      compactedToolIds,
      clearedAttachmentUUIDs,
    );
    const tokensSaved = Math.max(0, rawTokens - MICROCOMPACT_TRIMMED_RESULT_TOKENS);
    if (tokensSaved <= 0) continue;

    candidates.push({ requestId, tokensSaved });
  }

  return candidates;
};

const collectAttachmentCandidates = (
  events: ContextEvent[],
  clearedAttachmentUUIDs: Set<string>,
): string[] => {
  const candidates: string[] = [];
  let seenAssistantReply = false;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
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

type MicrocompactPlan = {
  compactedToolIds: Set<string>;
  clearedAttachmentUUIDs: Set<string>;
  newlyCompactedToolIds: string[];
  newlyClearedAttachmentUUIDs: string[];
  trigger: MicrocompactTrigger;
  preTokens: number;
  tokensSaved: number;
};

const buildMicrocompactPlan = (
  events: ContextEvent[],
  options: HistoryBuildOptions["microcompact"],
): MicrocompactPlan => {
  const state = replayMicrocompactState(events);
  const trigger = options?.trigger ?? "auto";
  const preTokens = estimateTotalTokensForMicrocompact(
    events,
    state.compactedToolIds,
    state.clearedAttachmentUUIDs,
  );

  if (isMicrocompactDisabled(options?.enabled)) {
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

  const keepTokens = Math.max(
    1,
    Math.floor(options?.keepTokens ?? MICROCOMPACT_DEFAULT_KEEP_TOKENS),
  );
  const candidates = collectToolResultCandidates(
    events,
    state.compactedToolIds,
    state.clearedAttachmentUUIDs,
  );

  const protectedToolIds = new Set(
    candidates
      .slice(-MICROCOMPACT_PROTECT_RECENT_RESULTS)
      .map((candidate) => candidate.requestId),
  );

  const newlyCompactedToolIds: string[] = [];
  let plannedSavings = 0;

  for (const candidate of candidates) {
    if (protectedToolIds.has(candidate.requestId)) continue;
    if (preTokens - plannedSavings <= keepTokens) break;
    newlyCompactedToolIds.push(candidate.requestId);
    plannedSavings += candidate.tokensSaved;
  }

  const attachmentCandidates = collectAttachmentCandidates(
    events,
    state.clearedAttachmentUUIDs,
  );
  const newlyClearedAttachmentUUIDs: string[] = [];
  for (const uuid of attachmentCandidates) {
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
    (warningThresholdTokens !== undefined
      ? preTokens >= warningThresholdTokens
      : false);

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

export const eventsToHistoryMessages = (
  events: ContextEvent[],
  options: HistoryBuildOptions = {},
): HistoryBuildResult => {
  const out: HistoryMessage[] = [];
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
      const toolMessage = formatToolRequest(event);
      out.push(toolMessage);
      const payload = asObjectRecord(event.payload);
      const toolName = normalizeToolName(payload);
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
      const textMessage = formatTextEvent(event, tsState);
      if (textMessage) out.push(textMessage);
      continue;
    }

    const taskMessage = formatTaskEvent(event.type, asObjectRecord(event.payload));
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
