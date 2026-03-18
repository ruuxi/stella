import { estimateContextEventTokens } from "./context_window";
import { asPlainObjectRecord } from "./object_utils";
import { truncateWithSuffix } from "./text_utils";

/**
 * Generic context event shape compatible with Convex event docs and local test fixtures.
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

const MAX_TEXT_CHARS = 30_000;
const MICROCOMPACT_MIN_SAVED_TOKENS = 20_000;
const MICROCOMPACT_DEFAULT_KEEP_TOKENS = 40_000;
const MICROCOMPACT_ATTACHMENT_TOKENS = 2_000;

const ellipsize = truncateWithSuffix;
const asObject = asPlainObjectRecord;

const getEnvVar = (key: string): string | undefined => {
  try {
    return typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  } catch {
    return undefined;
  }
};

const isMicrocompactDisabled = (enabledOverride?: boolean): boolean => {
  if (enabledOverride === false) return true;
  const envDisabled = String(getEnvVar("DISABLE_MICROCOMPACT") ?? "").toLowerCase();
  return envDisabled === "1" || envDisabled === "true";
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
      lines.push(`result: ${JSON.stringify(payload.result)}`);
    }
    return { role: "user", content: lines.join("\n") };
  }
  if (eventType === "task_failed") {
    const lines = ["[Task failed]"];
    if (taskId) lines.push(`task_id: ${taskId}`);
    if (payload.error !== undefined) {
      lines.push(`error: ${String(payload.error)}`);
    }
    return { role: "user", content: lines.join("\n") };
  }
  return null;
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
  const payload = asObject(event.payload);
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) return null;
  const { tag, dateStr } = formatMessageTimestamp(event.timestamp, tsState.prevDate, tsState.timezone);
  tsState.prevDate = dateStr;
  return {
    role: event.type === "assistant_message" ? "assistant" : "user",
    content: `${ellipsize(text, MAX_TEXT_CHARS)}\n\n${tag}`,
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
  const payload = asObject(event.payload);
  const attachments = Array.isArray(payload.attachments)
    ? (payload.attachments as Array<unknown>)
    : [];

  const out: string[] = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = asObject(attachments[index]);
    const id = typeof attachment.id === "string" ? attachment.id.trim() : "";
    const uuid = id || `${event._id}:attachment:${index}`;
    if (uuid.length > 0) out.push(uuid);
  }
  return out;
};

type MicrocompactState = {
  clearedAttachmentUUIDs: Set<string>;
};

const replayMicrocompactState = (events: ContextEvent[]): MicrocompactState => {
  const clearedAttachmentUUIDs = new Set<string>();

  for (const event of events) {
    if (event.type !== "microcompact_boundary") continue;
    const payload = asObject(event.payload);
    const cleared = asStringArray(payload.clearedAttachmentUUIDs);
    for (const uuid of cleared) clearedAttachmentUUIDs.add(uuid);
  }

  return { clearedAttachmentUUIDs };
};

const estimateEventTokensForMicrocompact = (
  event: ContextEvent,
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let estimated = estimateContextEventTokens({
    type: event.type,
    payload: event.payload,
    requestId: event.requestId,
  });

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
  clearedAttachmentUUIDs: Set<string>,
): number => {
  let total = 0;
  for (const event of events) {
    total += estimateEventTokensForMicrocompact(event, clearedAttachmentUUIDs);
  }
  return total;
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
  clearedAttachmentUUIDs: Set<string>;
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
    state.clearedAttachmentUUIDs,
  );

  if (isMicrocompactDisabled(options?.enabled)) {
    return {
      clearedAttachmentUUIDs: state.clearedAttachmentUUIDs,
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

  const attachmentCandidates = collectAttachmentCandidates(
    events,
    state.clearedAttachmentUUIDs,
  );
  const newlyClearedAttachmentUUIDs: string[] = [];
  let plannedSavings = 0;

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
      clearedAttachmentUUIDs: state.clearedAttachmentUUIDs,
      newlyClearedAttachmentUUIDs: [],
      trigger,
      preTokens,
      tokensSaved: 0,
    };
  }

  const clearedAttachmentUUIDs = new Set(state.clearedAttachmentUUIDs);
  for (const uuid of newlyClearedAttachmentUUIDs) {
    clearedAttachmentUUIDs.add(uuid);
  }

  const postTokens = estimateTotalTokensForMicrocompact(
    events,
    clearedAttachmentUUIDs,
  );

  return {
    clearedAttachmentUUIDs,
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
  const microcompactPlan = buildMicrocompactPlan(events, options.microcompact);
  const tsState: TimestampState = { timezone: options.timezone };

  for (const event of events) {
    if (event.type === "microcompact_boundary") {
      continue;
    }

    if (event.type === "user_message" || event.type === "assistant_message") {
      const textMessage = formatTextEvent(event, tsState);
      if (textMessage) out.push(textMessage);
      continue;
    }

    const taskMessage = formatTaskEvent(event.type, asObject(event.payload));
    if (taskMessage) out.push(taskMessage);
  }

  const hasBoundary = microcompactPlan.newlyClearedAttachmentUUIDs.length > 0;

  return {
    messages: out,
    ...(hasBoundary
      ? {
          microcompactBoundary: {
            trigger: microcompactPlan.trigger,
            preTokens: microcompactPlan.preTokens,
            tokensSaved: microcompactPlan.tokensSaved,
            compactedToolIds: [],
            clearedAttachmentUUIDs: microcompactPlan.newlyClearedAttachmentUUIDs,
          },
        }
      : {}),
  };
};
