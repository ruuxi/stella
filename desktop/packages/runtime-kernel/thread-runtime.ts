import { completeSimple, readAssistantText } from "../ai/stream.js";
import type { RuntimeThreadMessage } from "./storage/shared.js";
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
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const MIN_TRIGGER_TOKENS = 8_000;
const TAIL_USER_ASSISTANT_PAIRS = 4;
const MAX_BLOCK_CHARS = 100_000;

type ThreadMessage = {
  role: "user" | "assistant";
  content: string;
  toolCallId?: string;
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

const formatThreadMessagesForCompaction = (messages: ThreadMessage[]): string =>
  messages
    .map((message) => stringifyMessage(message))
    .filter((entry) => entry.length > 0)
    .join("\n\n");

const estimateMessageTokens = (message: ThreadMessage): number =>
  Math.max(1, Math.ceil((message.content ?? "").length / 4));

const getContextWindow = (route: ResolvedLlmRoute): number => {
  const value = Number(route.model.contextWindow);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_WINDOW_TOKENS;
  }
  return Math.floor(value);
};

const getCompactionTriggerTokens = (route: ResolvedLlmRoute): number =>
  Math.max(MIN_TRIGGER_TOKENS, getContextWindow(route) - THREAD_COMPACTION_RESERVE_TOKENS);

const getThreadTokenEstimate = (messages: ThreadMessage[]): number =>
  messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

const extractRecentTailStartIndex = (
  messages: ThreadMessage[],
  pairCount = TAIL_USER_ASSISTANT_PAIRS,
): number => {
  if (messages.length === 0) return 0;
  let userCount = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") {
      continue;
    }
    userCount += 1;
    if (userCount >= pairCount) {
      return index;
    }
  }
  return 0;
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
  messages: ThreadMessage[];
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
  const messages = args.store.loadThreadMessages(args.threadKey).filter(
    (entry): entry is ThreadMessage =>
      (entry.role === "user" || entry.role === "assistant") &&
      typeof entry.content === "string",
  );
  if (messages.length === 0) {
    return;
  }

  const totalTokens = getThreadTokenEstimate(messages);
  if (totalTokens < getCompactionTriggerTokens(args.resolvedLlm)) {
    return;
  }

  const tailStartIndex = extractRecentTailStartIndex(messages);
  if (tailStartIndex <= 0) {
    return;
  }

  const oldMessages = messages.slice(0, tailStartIndex);
  const recentMessages = messages.slice(tailStartIndex);
  if (oldMessages.length === 0 || recentMessages.length === 0) {
    return;
  }

  let previousSummary: string | undefined;
  const firstCheckpoint = parseThreadCheckpoint(oldMessages[0]!.content);
  const summarizableMessages = [...oldMessages];
  if (firstCheckpoint && oldMessages[0]!.role === "assistant") {
    previousSummary = firstCheckpoint.summary;
    summarizableMessages.shift();
  }

  const summary = await generateThreadSummary({
    messages: summarizableMessages,
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
      timestamp: Date.now(),
      threadKey: args.threadKey,
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    })),
  ];

  args.store.replaceThreadMessages(args.threadKey, nextMessages);
  args.store.updateThreadSummary(args.threadKey, summary);
};
