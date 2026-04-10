import { completeSimple, readAssistantText } from "../ai/stream.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "./storage/shared.js";
import type { RuntimeStore } from "./storage/runtime-store.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

const THREAD_CHECKPOINT_MARKER = "[[THREAD_CHECKPOINT]]";
const THREAD_COMPACTION_SYSTEM_PROMPT = "Output ONLY the summary content.";
const THREAD_COMPACTION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

When summarizing coding sessions:
- Focus on test output and code changes.
- Preserve exact file paths, function names, and error messages.
- Include critical file-read snippets verbatim when needed for continuity.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Constraints, preferences, or requirements]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Current blockers, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next step]

## Critical Context
- [Important paths, function names, errors, details needed to continue]

Keep sections concise. Preserve exact technical details needed to resume work.`;

const THREAD_COMPACTION_UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary in <previous-summary>.

Update the existing structured summary with new information:
- Preserve prior important context unless superseded
- Move completed items from In Progress to Done
- Add new decisions, errors, and outcomes
- Update Next Steps based on the latest state
- Preserve exact file paths, function names, and error messages
- Carry forward critical file-read snippets verbatim when still relevant

Use the same exact output format as the base summary prompt.`;

const THREAD_COMPACTION_RESERVE_TOKENS = 16_384;
const THREAD_COMPACTION_KEEP_RECENT_TOKENS = 20_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;
const MAX_BLOCK_CHARS = 100_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
const ESTIMATED_IMAGE_TOKENS = 1_200;

type ThreadMessage = {
  timestamp: number;
  role: "user" | "assistant";
  content: string;
  toolCallId?: string;
};

type StoredThreadMessage = {
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

const isCutPointMessage = (
  entry: StoredThreadMessage,
): entry is ThreadMessage =>
  (entry.role === "user" || entry.role === "assistant") &&
  typeof entry.content === "string";

const findTailStartIndexByTokenBudget = (
  messages: StoredThreadMessage[],
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
): number => {
  let earliestCutPoint: number | null = null;
  let nearestCutPoint: number | null = null;
  let thresholdReached = false;
  let accumulatedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCutPointMessage(messages[index]!)) {
      nearestCutPoint = index;
      earliestCutPoint = index;
      if (thresholdReached) {
        return index;
      }
    }

    accumulatedTokens += estimateStoredMessageTokens(messages[index]!);
    if (!thresholdReached && accumulatedTokens >= keepRecentTokens) {
      thresholdReached = true;
      if (nearestCutPoint !== null) {
        return nearestCutPoint;
      }
    }
  }

  return earliestCutPoint ?? 0;
};

export const splitThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
  keepRecentTokens = THREAD_COMPACTION_KEEP_RECENT_TOKENS,
): {
  oldMessages: StoredThreadMessage[];
  recentMessages: StoredThreadMessage[];
} | null => {
  if (messages.length === 0) {
    return null;
  }

  const tailStartIndex = findTailStartIndexByTokenBudget(
    messages,
    keepRecentTokens,
  );
  if (tailStartIndex <= 0) {
    return null;
  }

  const oldMessages = messages.slice(0, tailStartIndex);
  const recentMessages = messages.slice(tailStartIndex);
  if (oldMessages.length === 0 || recentMessages.length === 0) {
    return null;
  }

  return {
    oldMessages,
    recentMessages,
  };
};

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
    return args.conversationId;
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

const generateThreadSummary = async (args: {
  messages: StoredThreadMessage[];
  previousSummary?: string;
  resolvedLlm: ResolvedLlmRoute;
}): Promise<string | null> => {
  const apiKey = args.resolvedLlm.getApiKey()?.trim();
  if (!apiKey) {
    return null;
  }

  const formattedConversation = formatThreadMessagesForCompaction(args.messages);
  if (!formattedConversation.trim()) {
    return args.previousSummary?.trim() || null;
  }

  const promptBody = [
    `<conversation>\n${formattedConversation}\n</conversation>`,
    args.previousSummary?.trim()
      ? `<previous-summary>\n${args.previousSummary.trim()}\n</previous-summary>`
      : "",
    args.previousSummary?.trim()
      ? THREAD_COMPACTION_UPDATE_PROMPT
      : THREAD_COMPACTION_PROMPT,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

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

  const { oldMessages, recentMessages } = splitMessages;

  let previousSummary: string | undefined;
  const firstOldMessage = oldMessages[0];
  const firstCheckpoint =
    firstOldMessage?.role === "assistant"
      ? parseThreadCheckpoint(firstOldMessage.content)
      : null;
  const summaryInputMessages = [...oldMessages];
  if (firstCheckpoint) {
    previousSummary = firstCheckpoint.summary;
    summaryInputMessages.shift();
  }

  const summary = await generateThreadSummary({
    messages: summaryInputMessages,
    previousSummary,
    resolvedLlm: args.resolvedLlm,
  });
  if (!summary) {
    return;
  }

  const archivedPath = args.store.archiveCurrentThread(args.threadKey);
  const nextMessages: RuntimeThreadMessage[] = [
    {
      timestamp: Date.now(),
      threadKey: args.threadKey,
      role: "assistant",
      content: formatThreadCheckpointMessage({
        summary,
        ...(archivedPath ? { previousThreadFile: archivedPath } : {}),
      }),
    },
    ...recentMessages.map((message) => ({
      timestamp: message.timestamp,
      threadKey: args.threadKey,
      role: message.role as RuntimeThreadMessage["role"],
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.payload ? { payload: message.payload } : {}),
    })),
  ];

  args.store.replaceThreadMessages(args.threadKey, nextMessages);
  args.store.updateThreadSummary(args.threadKey, summary);
};
