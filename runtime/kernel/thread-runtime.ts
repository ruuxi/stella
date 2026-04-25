import { completeSimple, readAssistantText } from "../ai/stream.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "./storage/shared.js";
import type { RuntimeStore } from "./storage/runtime-store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
const THREAD_COMPACTION_SYSTEM_PROMPT = "Output ONLY the summary content.";
const THREAD_COMPACTION_RESERVE_TOKENS = 16_384;
const THREAD_COMPACTION_PROTECT_HEAD_MESSAGES = 3;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const THREAD_COMPACTION_MIN_TAIL_MESSAGES = 2;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;
const MAX_BLOCK_CHARS = 100_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
const ESTIMATED_IMAGE_TOKENS = 1_200;

type ThreadMessage = {
  timestamp: number;
  role: "user" | "assistant" | "runtimeInternal";
  content: string;
  toolCallId?: string;
};

type StoredThreadMessage = {
  entryId?: string;
  timestamp: number;
  role: string;
  content: string;
  toolCallId?: string;
  payload?: RuntimeThreadMessage["payload"];
};

type ThreadCheckpoint = {
  summary: string;
  previousThreadFile?: string;
};

export type ThreadCompactionPlan = {
  previousSummary?: string;
  fromEntryId: string;
  toEntryId: string;
  middleMessages: StoredThreadMessage[];
};

const truncateWithSuffix = (
  value: string,
  maxChars: number,
  suffix = "...(truncated)",
): string => (value.length <= maxChars ? value : `${value.slice(0, maxChars)}${suffix}`);

const ellipsize = (value: string): string => truncateWithSuffix(value.trim(), MAX_BLOCK_CHARS);

const truncateForSummary = (value: string, maxChars: number): string =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n[... ${value.length - maxChars} more characters truncated]`;

const stringifyMessage = (message: ThreadMessage): string => {
  const content = message.content.trim();
  if (!content) {
    return "";
  }
  if (message.role === "user") {
    return `[User] ${ellipsize(content)}`;
  }
  if (message.role === "runtimeInternal") {
    return `[Runtime] ${ellipsize(content)}`;
  }
  return `[Assistant] ${ellipsize(content)}`;
};

const stringifyPayloadMessage = (
  payload: PersistedRuntimeThreadPayload,
): string[] => {
  if (payload.role === "user") {
    const content =
      typeof payload.content === "string"
        ? payload.content
        : payload.content
            .map((block) =>
              block.type === "text"
                ? block.text
                : `[Image: ${block.mimeType}]`,
            )
            .join("\n");
    return content.trim() ? [`[User] ${content.trim()}`] : [];
  }

  if (payload.role === "assistant") {
    const parts: string[] = [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolCalls: string[] = [];

    for (const block of payload.content) {
      if (block.type === "text") {
        if (block.text.trim()) {
          textParts.push(block.text);
        }
        continue;
      }
      if (block.type === "thinking") {
        if (block.thinking.trim()) {
          thinkingParts.push(block.thinking);
        }
        continue;
      }
      toolCalls.push(
        `${block.name}(${Object.entries(block.arguments ?? {})
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ")})`,
      );
    }

    if (thinkingParts.length > 0) {
      parts.push(`[Assistant thinking] ${thinkingParts.join("\n")}`);
    }
    if (textParts.length > 0) {
      parts.push(`[Assistant] ${textParts.join("\n")}`);
    }
    if (toolCalls.length > 0) {
      parts.push(`[Assistant tool calls] ${toolCalls.join("; ")}`);
    }
    return parts;
  }

  const content = payload.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : `[Image: ${block.mimeType}]`,
    )
    .join("\n")
    .trim();
  return content
    ? [`[Tool result] ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`]
    : [];
};

const stringifyStoredMessage = (message: StoredThreadMessage): string[] => {
  if (message.payload) {
    return stringifyPayloadMessage(message.payload);
  }
  if (message.role === "toolResult") {
    const content = message.content.trim();
    return content ? [`[Tool result] ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`] : [];
  }
  return [stringifyMessage(message as ThreadMessage)].filter(
    (entry) => entry.length > 0,
  );
};

export const formatThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
): string =>
  messages
    .flatMap((message) => stringifyStoredMessage(message))
    .filter((entry) => entry.length > 0)
    .join("\n\n");

const estimateMessageTokens = (message: ThreadMessage): number =>
  Math.max(1, Math.ceil((message.content ?? "").length / 4));

const estimatePayloadTokens = (
  payload: PersistedRuntimeThreadPayload,
): number => {
  if (payload.role === "user") {
    if (typeof payload.content === "string") {
      return Math.max(1, Math.ceil(payload.content.length / 4));
    }
    let tokens = 0;
    for (const block of payload.content) {
      tokens +=
        block.type === "text"
          ? Math.max(1, Math.ceil(block.text.length / 4))
          : ESTIMATED_IMAGE_TOKENS;
    }
    return tokens;
  }

  if (payload.role === "assistant") {
    let tokens = 0;
    for (const block of payload.content) {
      if (block.type === "text") {
        tokens += Math.max(1, Math.ceil(block.text.length / 4));
        continue;
      }
      if (block.type === "thinking") {
        tokens += Math.max(1, Math.ceil(block.thinking.length / 4));
        continue;
      }
      tokens += Math.max(
        1,
        Math.ceil(
          (block.name.length + JSON.stringify(block.arguments ?? {}).length) / 4,
        ),
      );
    }
    return tokens;
  }

  let tokens = 0;
  for (const block of payload.content) {
    tokens +=
      block.type === "text"
        ? Math.max(1, Math.ceil(block.text.length / 4))
        : ESTIMATED_IMAGE_TOKENS;
  }
  return tokens;
};

const estimateStoredMessageTokens = (message: StoredThreadMessage): number =>
  message.payload
    ? estimatePayloadTokens(message.payload)
    : estimateMessageTokens(message as ThreadMessage);

const getContextWindow = (route: ResolvedLlmRoute): number => {
  const value = Number(route.model.contextWindow);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return Math.floor(value);
};

const getCompactionTriggerTokens = (route: ResolvedLlmRoute): number =>
  Math.max(MIN_TRIGGER_TOKENS, getContextWindow(route) - THREAD_COMPACTION_RESERVE_TOKENS);

export const getThreadTokenEstimate = (messages: StoredThreadMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateStoredMessageTokens(message), 0);

const isCompactionMessage = (message: StoredThreadMessage): boolean =>
  message.role === "assistant" && parseThreadCheckpoint(message.content) !== null;

const hasToolCalls = (message: StoredThreadMessage): boolean =>
  message.role === "assistant"
  && message.payload?.role === "assistant"
  && message.payload.content.some((block) => block.type === "toolCall");

const getToolCallIds = (message: StoredThreadMessage): Set<string> => {
  const ids = new Set<string>();
  if (message.role !== "assistant" || message.payload?.role !== "assistant") {
    return ids;
  }
  for (const block of message.payload.content) {
    if (block.type === "toolCall" && typeof block.id === "string") {
      ids.add(block.id);
    }
  }
  return ids;
};

const getToolResultId = (message: StoredThreadMessage): string | undefined => {
  if (message.role !== "toolResult") {
    return undefined;
  }
  if (message.payload?.role === "toolResult" && message.payload.toolCallId.trim()) {
    return message.payload.toolCallId.trim();
  }
  return message.toolCallId?.trim();
};

const isToolResultFor = (
  message: StoredThreadMessage,
  callIds: Set<string>,
): boolean => {
  const toolCallId = getToolResultId(message);
  return Boolean(toolCallId && callIds.has(toolCallId));
};

const alignBoundaryForward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  const previous = messages[index - 1];
  if (!previous || !hasToolCalls(previous)) {
    return index;
  }
  const callIds = getToolCallIds(previous);
  let nextIndex = index;
  while (
    nextIndex < messages.length
    && isToolResultFor(messages[nextIndex]!, callIds)
  ) {
    nextIndex += 1;
  }
  return nextIndex;
};

const alignBoundaryBackward = (
  messages: StoredThreadMessage[],
  index: number,
): number => {
  if (index <= 0 || index >= messages.length) {
    return index;
  }
  let nextIndex = index;
  while (nextIndex > 0) {
    const message = messages[nextIndex];
    if (!message) {
      break;
    }
    if (hasToolCalls(message)) {
      break;
    }
    const previous = messages[nextIndex - 1];
    if (!previous || !hasToolCalls(previous)) {
      break;
    }
    if (!isToolResultFor(message, getToolCallIds(previous))) {
      break;
    }
    nextIndex -= 1;
  }
  return nextIndex;
};

const findTailStartIndexByTokenBudget = (
  messages: StoredThreadMessage[],
  headEnd: number,
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
  minTailMessages = THREAD_COMPACTION_MIN_TAIL_MESSAGES,
): number => {
  let accumulatedTokens = 0;
  let tailStartIndex = messages.length;

  for (let index = messages.length - 1; index >= headEnd; index -= 1) {
    const messageTokens = estimateStoredMessageTokens(messages[index]!);
    if (accumulatedTokens + messageTokens > keepRecentTokens && tailStartIndex < messages.length) {
      break;
    }
    accumulatedTokens += messageTokens;
    tailStartIndex = index;
  }

  const minCutIndex = messages.length - minTailMessages;
  const cutIndex =
    minCutIndex >= headEnd
      ? Math.min(tailStartIndex, minCutIndex)
      : tailStartIndex;
  return alignBoundaryBackward(messages, cutIndex);
};

export const splitThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  protectHeadMessages = THREAD_COMPACTION_PROTECT_HEAD_MESSAGES,
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
  minTailMessages = THREAD_COMPACTION_MIN_TAIL_MESSAGES,
): ThreadCompactionPlan | null => {
  if (messages.length <= protectHeadMessages + minTailMessages) {
    return null;
  }

  let compressionStart = Math.min(protectHeadMessages, messages.length);
  compressionStart = alignBoundaryForward(messages, compressionStart);
  const tailStartIndex = findTailStartIndexByTokenBudget(
    messages,
    compressionStart,
    keepRecentTokens,
    minTailMessages,
  );
  if (tailStartIndex <= compressionStart) {
    return null;
  }

  const middleMessages = messages
    .slice(compressionStart, tailStartIndex)
    .filter((message) => !isCompactionMessage(message));
  if (middleMessages.length === 0) {
    return null;
  }

  const previousSummary =
    messages
      .map((message) => parseThreadCheckpoint(message.content)?.summary)
      .find((summary): summary is string => typeof summary === "string" && summary.trim().length > 0);
  const fromEntryId = middleMessages[0]?.entryId?.trim();
  const toEntryId = middleMessages[middleMessages.length - 1]?.entryId?.trim();
  if (!fromEntryId || !toEntryId) {
    return null;
  }

  return {
    ...(previousSummary ? { previousSummary } : {}),
    fromEntryId,
    toEntryId,
    middleMessages,
  };
};

export const resolveOrchestratorThreadKey = (conversationId: string): string =>
  conversationId;

export const buildRuntimeThreadKey = (args: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string => {
  const existing = args.threadId?.trim();
  if (existing) {
    return existing;
  }
  if (args.agentType === "orchestrator") {
    return resolveOrchestratorThreadKey(args.conversationId);
  }
  const threadKey = `run:${args.runId}`;
  return `${args.conversationId}::subagent::${args.agentType}::${threadKey}`;
};

export const parseThreadCheckpoint = (content: string): ThreadCheckpoint | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(THREAD_CHECKPOINT_MARKER)) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  let previousThreadFile: string | undefined;
  let bodyStart = 1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) {
      bodyStart = index + 1;
      break;
    }
    if (line.toLowerCase().startsWith("previous thread file:")) {
      const value = line.slice("previous thread file:".length).trim();
      previousThreadFile = value || undefined;
    }
  }

  const summary = lines.slice(bodyStart).join("\n").trim();
  if (!summary) {
    return null;
  }
  return {
    summary,
    ...(previousThreadFile ? { previousThreadFile } : {}),
  };
};

export const formatThreadCheckpointMessage = (checkpoint: ThreadCheckpoint): string =>
  [
    THREAD_CHECKPOINT_MARKER,
    ...(checkpoint.previousThreadFile
      ? [`Previous thread file: ${checkpoint.previousThreadFile}`]
      : []),
    "",
    checkpoint.summary.trim(),
  ].join("\n");

const computeSummaryBudget = (messages: StoredThreadMessage[]): number =>
  Math.max(100, Math.floor(getThreadTokenEstimate(messages) * 0.2));

const buildSummaryPrompt = (
  messages: StoredThreadMessage[],
  previousSummary: string | undefined,
  budget: number,
): string => {
  const formattedConversation = formatThreadMessagesForCompaction(messages).trim();
  if (!formattedConversation) {
    return previousSummary?.trim() ?? "";
  }
  if (previousSummary?.trim()) {
    return `You are updating a conversation summary. A previous summary exists below. New conversation turns have occurred since then and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary.trim()}

NEW TURNS TO INCORPORATE:
${formattedConversation}

Update the summary. PRESERVE existing information that is still relevant. ADD new information. Remove information only if it is clearly obsolete.

## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
  }

  return `Create a concise summary of this conversation that preserves the important information for future context.

CONVERSATION TO SUMMARIZE:
${formattedConversation}

Use this structure:

## Topic
[What the conversation is about]

## Key Points
[Important information, decisions, and conclusions from the conversation]

## Current State
[Where things stand now — what has been done, what is in progress]

## Open Items
[Unresolved questions, pending tasks, or next steps discussed]

Target ~${budget} tokens. Be factual — only include information that was explicitly discussed in the conversation. Do NOT invent file paths, commands, or details that were not mentioned. Write only the summary body.`;
};

const generateThreadSummary = async (args: {
  messages: StoredThreadMessage[];
  previousSummary?: string;
  resolvedLlm: ResolvedLlmRoute;
}): Promise<string | null> => {
  const apiKey = (await args.resolvedLlm.getApiKey())?.trim();
  if (!apiKey) {
    return null;
  }

  const formattedConversation = formatThreadMessagesForCompaction(args.messages);
  if (!formattedConversation.trim()) {
    return args.previousSummary?.trim() || null;
  }

  const promptBody = buildSummaryPrompt(
    args.messages,
    args.previousSummary,
    computeSummaryBudget(args.messages),
  );

  try {
    const message = await completeSimple(
      args.resolvedLlm.model,
      {
        systemPrompt: THREAD_COMPACTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: promptBody }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
      },
    );
    const text = readAssistantText(message);
    return text || null;
  } catch {
    return null;
  }
};

export const maybeCompactRuntimeThread = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
}): Promise<void> => {
  const storedMessages = args.store.loadThreadMessages(args.threadKey);
  if (storedMessages.length === 0) {
    return;
  }

  const totalTokens = getThreadTokenEstimate(storedMessages);
  if (totalTokens < getCompactionTriggerTokens(args.resolvedLlm)) {
    return;
  }

  const splitMessages = splitThreadMessagesForCompaction(storedMessages);
  if (!splitMessages) {
    return;
  }

  const summary = await generateThreadSummary({
    messages: splitMessages.middleMessages,
    previousSummary: splitMessages.previousSummary,
    resolvedLlm: args.resolvedLlm,
  });
  if (!summary) {
    return;
  }

  args.store.compactThread({
    threadKey: args.threadKey,
    summary,
    fromEntryId: splitMessages.fromEntryId,
    toEntryId: splitMessages.toEntryId,
    tokensBefore: totalTokens,
  });
  args.store.updateThreadSummary(args.threadKey, summary);
};
