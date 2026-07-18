import crypto from "crypto";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { ToolResult, ToolUpdateCallback } from "../tools/types.js";
import {
  runClaudeCodeTurn,
  shutdownClaudeCodeRuntime,
} from "../integrations/claude-code-session-runtime.js";
import {
  getClaudeCodeAgentModelId,
  getClaudeCodeRuntimeEffortLevel,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";
import {
  buildCodexPromptFromMessages,
  runCodexAgentTurn,
  shutdownCodexAppServerRuntime,
  shouldUseCodexAgentRuntime,
  type CodexCommandExecutionActivity,
} from "../integrations/codex-agent-runtime.js";
import {
  buildRuntimeSystemPrompt,
  buildSubagentSystemPrompt,
  createRuntimePromptAgentMessage,
} from "./run-preparation.js";
import {
  executeRuntimeToolCall,
  extractAttachImageBlocks,
  getRuntimeToolMetadata,
  truncateModelVisibleToolText,
} from "./tool-adapters.js";
import type { ImageCapTarget } from "../../ai/utils/image-caps.js";
import {
  markOrchestratorErrorReported,
  resolveInterruptionReason,
} from "./run-completion.js";
import {
  createExternalOrchestratorRunSession,
  createExternalSubagentRunSession,
  type ExternalOrchestratorRunSession,
  type ExternalSubagentRunSession,
} from "./run-session.js";
import { now, resolveLocalCliCwd, textFromUnknown } from "./shared.js";
import {
  buildHistorySource,
  buildOrchestratorPromptMessages,
  buildSubagentPromptMessages,
  persistAssistantReply,
  persistThreadCustomMessage,
  persistThreadPayloadMessage,
} from "./thread-memory.js";
import type {
  BaseRunOptions,
  OrchestratorRunOptions,
  RuntimeRunCallbacks,
  SubagentRunOptions,
  SubagentRunResult,
} from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "../../protocol/index.js";
import { sanitizeSensitiveData } from "../../contracts/sensitive-data.js";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const buildToolCallPayload = (args: {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-code",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

/**
 * Build an interim assistant message pairing streamed preamble text with the
 * tool call it precedes. Passing this through `recordAssistantMessageEnd`
 * stamps the emitted stream event with `followedByToolCall` (the recorder sets
 * it whenever a message carries a tool-call block), so the renderer keeps the
 * working indicator up across the preamble→tool gap instead of handing off to
 * the painted preamble text. External engines stream a visible preamble but,
 * unlike the default runtime, never record a message-end boundary before a
 * tool — so without this the indicator would dismiss on the preamble and only
 * reappear at tool-start.
 */
export const buildPreambleToolBoundaryMessage = (args: {
  preamble: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): AssistantMessage => ({
  role: "assistant",
  content: [
    { type: "text", text: args.preamble },
    {
      type: "toolCall",
      id: args.toolCallId,
      name: args.toolName,
      arguments: args.toolArgs,
    },
  ],
  api: "openai-codex-responses",
  provider: "openai-codex",
  model: "codex",
  usage: EMPTY_USAGE,
  stopReason: "toolUse",
  timestamp: now(),
});

type ExternalPreambleEngine = "claude_code" | "codex";

/** Persist one completed external-engine preamble as an authored interim
 * update. Stream fragments remain transient; the separate tool-call payload
 * is persisted by the tool boundary, and the final answer is persisted by
 * `persistAssistantReply`, so neither is duplicated here. */
export const persistExternalAssistantPreamble = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  preamble: string;
  engine: ExternalPreambleEngine;
  runId?: string;
  attemptGeneration?: number;
}): void => {
  const text = args.preamble.trim();
  if (!text) return;
  const claude = args.engine === "claude_code";
  persistThreadPayloadMessage(args.store, {
    threadKey: args.threadKey,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(typeof args.attemptGeneration === "number"
      ? { attemptGeneration: args.attemptGeneration }
      : {}),
    payload: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: claude ? "anthropic-messages" : "openai-codex-responses",
      provider: claude ? "anthropic" : "openai-codex",
      model: claude ? "claude-code" : "codex",
      usage: EMPTY_USAGE,
      stopReason: "toolUse",
      timestamp: now(),
    },
  });
};

/** Collect external-engine stream fragments until a tool boundary proves the
 * text is a complete authored interim message. Final-answer and interrupted
 * buffers are discarded by callers, so neither can be persisted as progress. */
export const createExternalAssistantUpdateBuffer = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalPreambleEngine;
  runId?: string;
  attemptGeneration?: number;
}) => {
  let text = "";
  return {
    append(chunk: string): void {
      text += chunk;
    },
    flushBeforeTool(): string {
      const preamble = text.trim();
      text = "";
      if (!preamble) return "";
      persistExternalAssistantPreamble({ ...args, preamble });
      return preamble;
    },
    discard(): void {
      text = "";
    },
  };
};

const buildToolResultText = (toolResult: {
  result?: unknown;
  error?: string;
}): string =>
  toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);

const buildToolResultContent = async (
  toolResult: {
    result?: unknown;
    error?: string;
  },
  imageCapTarget: ImageCapTarget = {},
): Promise<(TextContent | ImageContent)[]> => {
  const rawText = buildToolResultText(toolResult);
  const { text, images } = await extractAttachImageBlocks(
    rawText,
    imageCapTarget,
  );
  const truncatedText = truncateModelVisibleToolText(text);
  const content: (TextContent | ImageContent)[] = [];
  if (truncatedText.text || images.length === 0) {
    content.push({ type: "text", text: truncatedText.text });
  }
  content.push(...images);
  return content;
};

type ExternalEngineSessionKind =
  | "claude_code_local"
  | "claude_code_local_vanilla"
  | "codex_cli";

type ExternalOrchestratorEngine = "claude_code_local";

const shouldUseClaudeCodeRuntime = (opts: BaseRunOptions): boolean => {
  const primaryModelId = opts.agentContext.model ?? opts.resolvedLlm.model.id;
  return shouldUseClaudeCodeAgentRuntime({
    stellaAppDir: opts.stellaAppDir,
    agentEngine: opts.agentContext.agentEngine,
    modelId: primaryModelId,
  });
};

export const selectExternalOrchestratorEngine = (
  opts: BaseRunOptions,
): ExternalOrchestratorEngine | null => {
  if (shouldUseClaudeCodeRuntime(opts)) {
    return "claude_code_local";
  }
  return null;
};

const EXTERNAL_ENGINE_SESSION_PREFIXES: readonly string[] = [
  "claude_code_local:",
  // Vanilla per-spawn Claude Code sessions are persisted under their own
  // namespace so a takeover run never `--resume`s a vanilla conversation
  // (and vice versa).
  "claude_code_local_vanilla:",
  "codex_cli:",
];

export const getExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalSessionId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (raw.startsWith(expectedPrefix)) {
    const sessionId = raw.slice(expectedPrefix.length).trim();
    return sessionId || undefined;
  }
  if (
    EXTERNAL_ENGINE_SESSION_PREFIXES.some((prefix) => raw.startsWith(prefix))
  ) {
    return undefined;
  }
  // Existing Claude Code sessions were stored before engine namespacing.
  return args.engine === "claude_code_local" ? raw : undefined;
};

export const setExternalEngineSessionId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  sessionId: string;
}) => {
  args.store.setThreadExternalSessionId(
    args.threadKey,
    `${args.engine}:${args.sessionId}`,
  );
};

/**
 * The delivered watermark is engine-namespaced exactly like the session id:
 * each engine's CLI transcript only contains what THAT engine was prompted
 * with, so a Claude→Codex takeover must not inherit Claude's watermark —
 * Codex never receives a full-history reseed, and the delta is its only
 * channel for out-of-band rows. A mismatched (or legacy un-namespaced)
 * value reads as undefined, so the new engine's first turn delivers
 * everything it has not seen.
 */
export const getExternalDeliveredEntryId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
}): string | undefined => {
  const raw = args.store.getThreadExternalDeliveredEntryId(args.threadKey);
  if (!raw) return undefined;
  const expectedPrefix = `${args.engine}:`;
  if (raw.startsWith(expectedPrefix)) {
    const entryId = raw.slice(expectedPrefix.length).trim();
    return entryId || undefined;
  }
  return undefined;
};

export const setExternalDeliveredEntryId = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  engine: ExternalEngineSessionKind;
  entryId: string;
}) => {
  args.store.setThreadExternalDeliveredEntryId(
    args.threadKey,
    `${args.engine}:${args.entryId}`,
  );
};

const persistExternalPromptMessages = (
  opts: BaseRunOptions,
  threadKey: string,
  promptMessages: RuntimePromptMessage[],
) => {
  const promptInputs: Array<
    RuntimePromptMessage & { attachments?: RuntimeAttachmentRef[] }
  > =
    promptMessages.length > 0
      ? promptMessages
      : [
          {
            text: opts.userPrompt,
            attachments: opts.attachments,
          },
        ];
  const promptTimestamp = now();
  for (const [index, promptInput] of promptInputs.entries()) {
    const promptMessage = createRuntimePromptAgentMessage(
      promptInput,
      promptTimestamp + index,
    );
    const messageType = promptInput.messageType ?? "user";
    if (messageType === "user" && promptMessage.role === "user") {
      persistThreadPayloadMessage(opts.store, {
        threadKey,
        payload: promptMessage,
      });
    }
    if (
      messageType === "message" &&
      promptMessage.role === "runtimeInternal" &&
      promptInput.customType?.startsWith("bootstrap.")
    ) {
      persistThreadCustomMessage(opts.store, {
        threadKey,
        customType: promptInput.customType,
        content: promptMessage.content,
        display: promptMessage.display === true,
        timestamp: promptMessage.timestamp,
      });
    }
  }
};

const formatClaudePromptMessage = (
  message: RuntimePromptMessage,
  index: number,
): string => {
  const messageType = message.messageType ?? "user";
  const visibility = message.uiVisibility ?? "visible";
  const customType = message.customType?.trim();
  const attrs = [
    `index="${index + 1}"`,
    `type="${messageType}"`,
    `visibility="${visibility}"`,
    ...(customType
      ? [`customType="${customType.replaceAll('"', "&quot;")}"`]
      : []),
  ].join(" ");
  return `<message ${attrs}>\n${message.text.trim()}\n</message>`;
};

export const buildClaudePromptFromMessages = (
  promptMessages: RuntimePromptMessage[],
): string =>
  [
    "Stella is providing this turn as ordered prompt messages.",
    'Messages with visibility="hidden" are runtime context for you only; do not quote or reveal them unless the user explicitly asks about the relevant fact.',
    ...promptMessages.map(formatClaudePromptMessage),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

type ExternalQueuedMessage = {
  message: AgentMessage;
  delivery: "steer" | "followUp";
};

const contentToText = (content: AgentMessage["content"]): string => {
  if (typeof content === "string") {
    return content.trim();
  }
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall") {
        return `[Tool call] ${block.name}\n${textFromUnknown(block.arguments)}`;
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0)
    .join("\n\n")
    .trim();
};

export const buildExternalStellaHistoryPromptMessage = (args: {
  opts: BaseRunOptions;
  promptMessages: RuntimePromptMessage[];
}): RuntimePromptMessage | null => {
  const history = buildHistorySource(args.opts.agentContext);
  if (history.length === 0) {
    return null;
  }
  const lastPromptUserText = [...args.promptMessages]
    .reverse()
    .find((message) => (message.messageType ?? "user") === "user")
    ?.text.trim();
  const trimmedHistory = [...history];
  const lastHistory = trimmedHistory[trimmedHistory.length - 1];
  if (
    lastHistory?.role === "user" &&
    lastPromptUserText &&
    contentToText(lastHistory.content) === lastPromptUserText
  ) {
    trimmedHistory.pop();
  }
  const lines = trimmedHistory
    .map((message, index) => {
      const text = contentToText(message.content);
      if (!text) return "";
      return `<history_message index="${index + 1}" role="${message.role}">\n${text}\n</history_message>`;
    })
    .filter((entry) => entry.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return {
    messageType: "message",
    uiVisibility: "hidden",
    customType: "runtime.stella_thread_history",
    text: [
      '<stella_thread_history source="stella" note="Stella chat/runtime history is the source of truth for recall. Use it to answer questions about prior Stella messages, even when external engine session state is unavailable or incomplete.">',
      ...lines,
      "</stella_thread_history>",
    ].join("\n"),
  };
};

/**
 * Out-of-band rows the orchestration layer appends to a thread without going
 * through the engine's own turn loop — managed-child terminal reports and
 * interim task updates (see runner/agent-orchestration.ts). The Pi engine
 * picks these up through its history refresh; external engines resume from
 * their own CLI transcript, so these rows must be injected explicitly.
 */
const EXTERNAL_DELTA_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "runtime.task_lifecycle",
  "runtime.task_update",
]);

export type ExternalThreadUpdatesDelta = {
  /** Hidden prompt message carrying the undelivered rows, or null. */
  message: RuntimePromptMessage | null;
  /**
   * Entry id of the newest out-of-band row observed while building the delta
   * (whether injected or deduplicated against this turn's prompt messages).
   * Persist it as the delivered watermark once the turn succeeds; null when
   * the thread has no out-of-band rows at all.
   */
  lastEntryId: string | null;
};

/**
 * Build the delta of out-of-band runtime rows an external engine session has
 * not seen yet.
 *
 * The full Stella-history block is only sent on session-creating turns (see
 * `buildClaudeCodeTurnPrompts`); resumed turns rely on the CLI transcript,
 * which never contains rows written out-of-band by the orchestration layer —
 * e.g. a manager's `runtime.task_lifecycle` child reports, whose wake prompt
 * is deliberately a content-free stub. This delta carries exactly those rows
 * persisted after `afterEntryId` (the delivered watermark), keeping resumed
 * prompts small instead of re-sending the whole history each turn.
 *
 * Candidates are scanned from the RAW entry log, not the compaction-overlaid
 * projection: a compaction checkpoint folds a range into one summary row, and
 * an undelivered report inside that range would otherwise stop being a
 * candidate while newer surviving rows advance the watermark past it —
 * silently dropping it for engines that never re-read Stella history. The
 * watermark bounds the scan, so raw reads stay small and deliver-once.
 *
 * Rows whose text is already present verbatim in this turn's prompt messages
 * (e.g. an orchestrator's in-memory follow-up delivery of the same report)
 * or contained in a `deliveredContextTexts` block that rides in the SAME
 * prompt (the full-history block on session-creating turns) are counted as
 * delivered but omitted from the block. The caller must guarantee that the
 * returned message is included in every prompt variant actually sent —
 * including resume-fallback reseeds — because `lastEntryId` becomes the
 * delivered watermark on turn success.
 */
export const buildExternalThreadUpdatesDelta = (args: {
  store: BaseRunOptions["store"];
  threadKey: string;
  afterEntryId?: string;
  promptMessages: RuntimePromptMessage[];
  /**
   * Texts of context blocks included in the same prompt as the delta (e.g.
   * the full Stella-history block). Rows already contained in one of them
   * are delivered by that block, not re-injected.
   */
  deliveredContextTexts?: string[];
}): ExternalThreadUpdatesDelta => {
  const candidates = args.store
    .loadRawThreadMessagesWithEntryTypes(args.threadKey)
    .filter(
      (row) =>
        row.sourceEntryType === "custom_message" &&
        typeof row.entryId === "string" &&
        row.entryId.length > 0 &&
        row.customMessage !== undefined &&
        EXTERNAL_DELTA_CUSTOM_TYPES.has(row.customMessage.customType),
    );
  if (candidates.length === 0) {
    return { message: null, lastEntryId: null };
  }
  const lastEntryId = candidates[candidates.length - 1]?.entryId ?? null;
  const afterIndex = args.afterEntryId
    ? candidates.findIndex((row) => row.entryId === args.afterEntryId)
    : -1;
  const undelivered = candidates.slice(afterIndex + 1);
  if (undelivered.length === 0) {
    return { message: null, lastEntryId };
  }
  const promptTexts = new Set(
    args.promptMessages
      .map((message) => message.text.trim())
      .filter((text) => text.length > 0),
  );
  const contextTexts = (args.deliveredContextTexts ?? []).filter(
    (text) => text.trim().length > 0,
  );
  const lines = undelivered
    .flatMap((row) => {
      const text = row.content.trim();
      if (!text || promptTexts.has(text)) return [];
      if (contextTexts.some((context) => context.includes(text))) return [];
      return [{ customType: row.customMessage!.customType, text }];
    })
    .map(
      (row, index) =>
        `<thread_update index="${index + 1}" customType="${row.customType}">\n${row.text}\n</thread_update>`,
    );
  if (lines.length === 0) {
    return { message: null, lastEntryId };
  }
  return {
    message: {
      messageType: "message",
      uiVisibility: "hidden",
      customType: "runtime.stella_thread_updates",
      text: [
        '<stella_thread_updates source="stella" note="Runtime events (managed-agent reports and task updates) persisted to this Stella thread since your previous turn. They are not in your session transcript; treat them as delivered context.">',
        ...lines,
        "</stella_thread_updates>",
      ].join("\n"),
    },
    lastEntryId,
  };
};

/**
 * Build the per-turn Claude Code prompt pair.
 *
 * The stored Stella history (already checkpoint-compacted by
 * `loadThreadMessages`) is prepended to the main prompt only when there is no
 * resumable CLI session for this thread — a brand-new session or an
 * engine-switch takeover. Resumed turns must NOT re-send it: the resumed CLI
 * conversation already contains everything from prior turns, and re-injecting
 * the full history every turn grows the session transcript quadratically
 * until Claude Code's own auto-compaction fires on every turn (an endless
 * "Compacting context" loop). A lost or looping session still reseeds from
 * the checkpoint-style history through `resumeFallbackPrompt`.
 *
 * Every variant additionally carries `deltaPromptMessage` — the out-of-band
 * rows (managed-child reports, task updates) not covered by the other blocks
 * (see `buildExternalThreadUpdatesDelta`). The history block is built from a
 * snapshot taken at run-context construction, so a report that lands in the
 * store during that async window is missing from it; the delta (computed
 * against the live store, deduplicated against the history text) is what
 * delivers it. Because a lost resume or compaction loop replaces the main
 * prompt with `resumeFallbackPrompt` (possibly embedded in a reconciliation
 * prompt), the fallback must carry the delta too — the delivered watermark
 * advances past these rows on success, so they must be present no matter
 * which prompt variant was actually sent.
 */
export const buildClaudeCodeTurnPrompts = (args: {
  historyPromptMessage: RuntimePromptMessage | null;
  promptMessages: RuntimePromptMessage[];
  hasPersistedSession: boolean;
  deltaPromptMessage?: RuntimePromptMessage | null;
}): { prompt: string; resumeFallbackPrompt?: string } => {
  const historyPrefixedPrompt = args.historyPromptMessage
    ? buildClaudePromptFromMessages([
        args.historyPromptMessage,
        ...(args.deltaPromptMessage ? [args.deltaPromptMessage] : []),
        ...args.promptMessages,
      ])
    : undefined;
  const prompt =
    !args.hasPersistedSession && historyPrefixedPrompt
      ? historyPrefixedPrompt
      : buildClaudePromptFromMessages(
          args.deltaPromptMessage
            ? [args.deltaPromptMessage, ...args.promptMessages]
            : args.promptMessages,
        );
  return {
    prompt,
    ...(historyPrefixedPrompt
      ? { resumeFallbackPrompt: historyPrefixedPrompt }
      : {}),
  };
};

const formatQueuedClaudeMessage = (
  entry: ExternalQueuedMessage,
  index: number,
): RuntimePromptMessage => {
  const text = contentToText(entry.message.content);
  if (entry.message.role === "runtimeInternal") {
    return {
      text,
      messageType: "message",
      uiVisibility: "hidden",
      customType: entry.message.customType ?? `runtime.${entry.delivery}`,
      display: entry.message.display,
    };
  }
  return {
    text,
    messageType: "user",
    uiVisibility: "hidden",
    customType: `runtime.queued_${entry.delivery}_${index + 1}`,
  };
};

const attachmentsFromQueuedMessages = (
  entries: ExternalQueuedMessage[],
): RuntimeAttachmentRef[] =>
  entries.flatMap((entry) => {
    if (typeof entry.message.content === "string") {
      return [];
    }
    return entry.message.content.flatMap(
      (block: TextContent | ImageContent | ThinkingContent | ToolCall) =>
        block.type === "image"
          ? [
              {
                url: `data:${block.mimeType};base64,${block.data}`,
                mimeType: block.mimeType,
              },
            ]
          : [],
    );
  });

const createExternalLiveAgent = () => {
  const queued: ExternalQueuedMessage[] = [];
  const state = { isStreaming: true };
  return {
    agent: {
      state,
      steer: (message: AgentMessage) => {
        queued.push({ message, delivery: "steer" });
      },
      followUp: (message: AgentMessage) => {
        queued.push({ message, delivery: "followUp" });
      },
      clearAllQueues: () => {
        queued.splice(0, queued.length);
      },
    },
    drain(): ExternalQueuedMessage[] {
      return queued.splice(0, queued.length);
    },
    finish(): void {
      state.isStreaming = false;
    },
  };
};

const runClaudeHostedTurn = async (args: {
  opts: BaseRunOptions;
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  // Orchestrator sessions own the response-target tracker; subagent sessions
  // do not (they don't drive the user-facing chat surface).
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });
  // Per-spawn claude-code selection (spawn_agent `model: claude-code[/...]`)
  // runs vanilla Claude Code: CC keeps its own tools and config — no Stella
  // tool bridge, no system-prompt override (the headless flags and hook
  // settings still apply). The global engine preference keeps the full
  // takeover behavior (spawnEngine is never set on that path).
  const spawnEngine = args.opts.agentContext.spawnEngine;
  const vanilla = spawnEngine?.engine === "claude_code_local";
  const baseSessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  // Mode-suffixed so a later default-engine run on the same thread never
  // reuses a CLI process that was started with vanilla arguments.
  const sessionKey = vanilla ? `${baseSessionKey}:vanilla` : baseSessionKey;
  // The persisted CLI session id is namespaced by mode too, so a takeover
  // run never resumes a vanilla conversation on the same thread.
  const sessionEngine: "claude_code_local" | "claude_code_local_vanilla" =
    vanilla ? "claude_code_local_vanilla" : "claude_code_local";
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });
  const toolMetadata = vanilla
    ? []
    : getRuntimeToolMetadata({
        toolsAllowlist: args.opts.agentContext.toolsAllowlist,
        toolCatalog: args.opts.toolCatalog,
      });
  const claudeCodeModelId = getClaudeCodeAgentModelId(
    args.opts.stellaAppDir,
    args.opts.agentContext.model,
    args.opts.agentType,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? args.opts.agentContext.modelConfigSnapshot.engineModel
      : vanilla
        ? spawnEngine?.model
        : undefined,
  );
  const emitToolUpdateStatus = (update: {
    result?: unknown;
    details?: unknown;
    error?: string;
  }) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };
  // Buffers the assistant text Claude Code has streamed since the last
  // message boundary (mirrors runCodexHostedTurn.flushPreambleBeforeTool).
  // Claude Code CAN stream a natural-text preamble before a structured
  // tool-request step resolves; without a boundary event the next step's text
  // would append to the same overlay slot with no separator — visually fusing
  // the preamble's last word with the answer's first word — and the working
  // indicator would dismiss on the preamble across the preamble->tool gap.
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "claude_code",
    runId,
    ...(typeof args.opts.agentContext.attemptGeneration === "number"
      ? { attemptGeneration: args.opts.agentContext.attemptGeneration }
      : {}),
  });
  const acceptClaudeStreamChunk = (chunk: string) => {
    assistantUpdateBuffer.append(chunk);
    args.callbacks?.onStream?.(runEvents.recordStream(chunk));
  };
  const flushPreambleBeforeTool = (toolArgs2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: toolArgs2.toolCallId,
        toolName: toolArgs2.toolName,
        toolArgs: toolArgs2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const executeClaudeTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    // The Claude Code engine runs on Anthropic; tool-result screenshots get
    // Anthropic's high-resolution-tier caps (2576px long edge).
    const imageCapTarget: ImageCapTarget = { provider: "anthropic" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: args.opts.agentContext.toolsAllowlist,
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };

  const historyPromptMessage = buildExternalStellaHistoryPromptMessage({
    opts: args.opts,
    promptMessages: args.promptMessages,
  });
  // Out-of-band rows (managed-child reports, task updates) persisted since
  // the last turn THIS engine saw, injected into every prompt variant. On
  // session-creating turns the delta is deduplicated against the full
  // history block sent alongside it: the history snapshot predates this run,
  // so a report that landed during context construction is only in the
  // delta. The watermark may only advance past rows present in the sent
  // prompt, which this arrangement guarantees by construction.
  const initialDeliveredEntryId = getExternalDeliveredEntryId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
  });
  const threadUpdatesDelta = buildExternalThreadUpdatesDelta({
    store: args.opts.store,
    threadKey,
    ...(initialDeliveredEntryId
      ? { afterEntryId: initialDeliveredEntryId }
      : {}),
    promptMessages: args.promptMessages,
    ...(!persistedSessionId && historyPromptMessage
      ? { deliveredContextTexts: [historyPromptMessage.text] }
      : {}),
  });
  let deliveredEntryWatermark =
    threadUpdatesDelta.lastEntryId ?? initialDeliveredEntryId;
  const { prompt, resumeFallbackPrompt } = buildClaudeCodeTurnPrompts({
    historyPromptMessage,
    promptMessages: args.promptMessages,
    hasPersistedSession: Boolean(persistedSessionId),
    deltaPromptMessage: threadUpdatesDelta.message,
  });
  const claudeCodeEffortLevel = getClaudeCodeRuntimeEffortLevel(
    args.opts.stellaAppDir,
    args.opts.agentContext.modelConfigSnapshot?.engine === "claude_code_local"
      ? args.opts.agentContext.modelConfigSnapshot.reasoningEffort
      : args.opts.agentContext.spawnReasoningEffort,
  );

  // Native-tool file writes (vanilla mode) accumulated across the main turn
  // and any queued follow-up turns, deduped by path + change kind.
  const collectedFileChanges: NonNullable<SubagentRunResult["fileChanges"]> =
    [];
  const collectedFileChangeKeys = new Set<string>();
  const collectTurnFileChanges = (
    fileChanges: SubagentRunResult["fileChanges"],
  ) => {
    for (const change of fileChanges ?? []) {
      const key = `${change.kind.type}:${change.path}:${change.kind.type === "update" ? (change.kind.move_path ?? "") : ""}`;
      if (collectedFileChangeKeys.has(key)) continue;
      collectedFileChangeKeys.add(key);
      collectedFileChanges.push(change);
    }
  };

  let finalResult = await runClaudeCodeTurn({
    runId,
    sessionKey,
    persistedSessionId,
    modelId: claudeCodeModelId,
    stellaAppDir: args.opts.stellaAppDir,
    ...(args.opts.cliBridgeSocketPath
      ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
      : {}),
    ...(vanilla ? { vanilla } : {}),
    ...(claudeCodeEffortLevel ? { effortLevel: claudeCodeEffortLevel } : {}),
    prompt,
    ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
    systemPrompt: args.systemPrompt,
    cwd: localCliCwd,
    attachments: args.opts.attachments,
    tools: toolMetadata,
    abortSignal: args.opts.abortSignal,
    onStatusChange: (status) => {
      args.callbacks?.onStatus?.(
        runEvents.recordStatus(status.text, status.state),
      );
    },
    onStream: acceptClaudeStreamChunk,
    onNativeToolStart: flushPreambleBeforeTool,
    onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    executeTool: executeClaudeTool,
  });
  // The remaining buffer is this turn's final answer. It is persisted exactly
  // once below, never carried into a queued turn's next tool preamble.
  assistantUpdateBuffer.discard();
  collectTurnFileChanges(finalResult.fileChanges);

  for (;;) {
    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      break;
    }
    const queuedStarted = runEvents.recordQueuedUserMessageStart();
    if (queuedStarted) {
      args.callbacks?.onRunStarted?.(queuedStarted);
    }
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    const queuedHistoryPromptMessage = buildExternalStellaHistoryPromptMessage({
      opts: args.opts,
      promptMessages: queuedPromptMessages,
    });
    // Out-of-band rows persisted while this turn was running (e.g. a child
    // completing mid-turn) — delivered from the in-turn watermark so nothing
    // sent by the main prompt repeats. Included in the queued fallback
    // prompt too (via buildClaudeCodeTurnPrompts), so a reseed mid-queue
    // still carries them.
    const queuedThreadUpdatesDelta = buildExternalThreadUpdatesDelta({
      store: args.opts.store,
      threadKey,
      ...(deliveredEntryWatermark
        ? { afterEntryId: deliveredEntryWatermark }
        : {}),
      promptMessages: queuedPromptMessages,
    });
    deliveredEntryWatermark =
      queuedThreadUpdatesDelta.lastEntryId ?? deliveredEntryWatermark;
    // Queued follow-ups always continue the session the turn just ran on, so
    // the main prompt never re-sends history; a lost resume reseeds via the
    // fallback prompt.
    const {
      prompt: queuedPrompt,
      resumeFallbackPrompt: queuedResumeFallbackPrompt,
    } = buildClaudeCodeTurnPrompts({
      historyPromptMessage: queuedHistoryPromptMessage,
      promptMessages: queuedPromptMessages,
      hasPersistedSession: true,
      deltaPromptMessage: queuedThreadUpdatesDelta.message,
    });
    finalResult = await runClaudeCodeTurn({
      runId,
      sessionKey,
      persistedSessionId: finalResult.sessionId,
      modelId: claudeCodeModelId,
      stellaAppDir: args.opts.stellaAppDir,
      ...(args.opts.cliBridgeSocketPath
        ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
        : {}),
      ...(vanilla ? { vanilla } : {}),
      ...(claudeCodeEffortLevel ? { effortLevel: claudeCodeEffortLevel } : {}),
      prompt: queuedPrompt,
      ...(queuedResumeFallbackPrompt
        ? { resumeFallbackPrompt: queuedResumeFallbackPrompt }
        : {}),
      systemPrompt: args.systemPrompt,
      cwd: localCliCwd,
      attachments: queuedAttachments,
      tools: toolMetadata,
      abortSignal: args.opts.abortSignal,
      onStatusChange: (status) => {
        args.callbacks?.onStatus?.(
          runEvents.recordStatus(status.text, status.state),
        );
      },
      onStream: acceptClaudeStreamChunk,
      onNativeToolStart: flushPreambleBeforeTool,
      executeTool: executeClaudeTool,
      onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    });
    assistantUpdateBuffer.discard();
    collectTurnFileChanges(finalResult.fileChanges);
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
    stellaDataDir: args.opts.stellaDataDir,
  });
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  setExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: sessionEngine,
    sessionId: finalResult.sessionId,
  });
  // Only persisted on success: an aborted/failed turn re-delivers the same
  // rows next turn (at-least-once) instead of silently dropping them.
  if (
    deliveredEntryWatermark &&
    deliveredEntryWatermark !== initialDeliveredEntryId
  ) {
    setExternalDeliveredEntryId({
      store: args.opts.store,
      threadKey,
      engine: sessionEngine,
      entryId: deliveredEntryWatermark,
    });
  }

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    ...(collectedFileChanges.length > 0
      ? { fileChanges: collectedFileChanges }
      : {}),
  };
};

const runCodexHostedTurn = async (args: {
  opts: BaseRunOptions & { onProgress?: (chunk: string) => void };
  session: ExternalOrchestratorRunSession | ExternalSubagentRunSession;
  systemPrompt: string;
  promptMessages: RuntimePromptMessage[];
  callbacks?: Partial<RuntimeRunCallbacks>;
  liveAgent?: ReturnType<typeof createExternalLiveAgent>;
}): Promise<{
  finalText: string;
  sessionId: string;
  fileChanges?: SubagentRunResult["fileChanges"];
}> => {
  const { runId, threadKey, runEvents } = args.session;
  const responseTargetTracker =
    args.session.kind === "orchestrator"
      ? args.session.responseTargetTracker
      : undefined;

  runEvents.recordRunStart();
  persistExternalPromptMessages(args.opts, threadKey, args.promptMessages);

  if (args.opts.abortSignal?.aborted) {
    throw new Error("Aborted");
  }

  const localCliCwd = resolveLocalCliCwd({
    agentType: args.opts.agentType,
    stellaAppDir: args.opts.stellaAppDir,
  });
  const sessionKey = args.opts.agentContext.activeThreadId
    ? `${args.opts.conversationId}:${args.opts.agentContext.activeThreadId}`
    : `${args.opts.conversationId}:run:${runId}`;
  const persistedSessionId = getExternalEngineSessionId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const persistCodexSessionId = (sessionId: string) => {
    setExternalEngineSessionId({
      store: args.opts.store,
      threadKey,
      engine: "codex_cli",
      sessionId,
    });
  };
  const emitToolUpdateStatus = (update: ToolResult) => {
    const details =
      update.details && typeof update.details === "object"
        ? (update.details as { statusText?: unknown })
        : null;
    const statusText =
      typeof details?.statusText === "string" && details.statusText.trim()
        ? details.statusText.trim()
        : buildToolResultText(update).trim();
    if (statusText) {
      args.callbacks?.onStatus?.(runEvents.recordStatus(statusText));
    }
  };
  // Buffers the assistant text Codex has streamed since the last message
  // boundary. When a tool call starts we flush it as an interim, tool-call-
  // bearing message (see `flushPreambleBeforeTool`) so the working indicator
  // does not dismiss on the preamble across the gap before the tool starts.
  const assistantUpdateBuffer = createExternalAssistantUpdateBuffer({
    store: args.opts.store,
    threadKey,
    engine: "codex",
    runId,
    ...(typeof args.opts.agentContext.attemptGeneration === "number"
      ? { attemptGeneration: args.opts.agentContext.attemptGeneration }
      : {}),
  });
  const flushPreambleBeforeTool = (args2: {
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => {
    const preamble = assistantUpdateBuffer.flushBeforeTool();
    if (!preamble) {
      return;
    }
    const preambleEvent = runEvents.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble,
        toolCallId: args2.toolCallId,
        toolName: args2.toolName,
        toolArgs: args2.toolArgs,
      }),
    );
    if (preambleEvent) {
      args.callbacks?.onAssistantMessage?.(preambleEvent);
    }
  };
  const acceptCodexAssistantChunk = (chunk: string) => {
    assistantUpdateBuffer.append(chunk);
    args.opts.onProgress?.(chunk);
    args.callbacks?.onStream?.(runEvents.recordStream(chunk));
  };
  const executeCodexTool = async (
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => {
    // The Codex engine runs on OpenAI; tool-result screenshots get OpenAI's
    // image caps (2048px long edge for high detail).
    const imageCapTarget: ImageCapTarget = { provider: "openai" };
    flushPreambleBeforeTool({ toolCallId, toolName, toolArgs });
    responseTargetTracker?.noteToolStart(toolName, toolArgs);
    const toolStartEvent = runEvents.recordToolStart({
      toolCallId,
      toolName,
      toolArgs,
    });
    args.callbacks?.onToolStart?.(toolStartEvent);
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: buildToolCallPayload({
        toolCallId,
        toolName,
        toolArgs: toolStartEvent.args,
      }),
    });
    const toolResult = await executeRuntimeToolCall({
      toolCallId,
      toolName,
      args: toolArgs,
      runId,
      rootRunId: args.opts.rootRunId ?? runId,
      agentId: args.opts.agentId,
      conversationId: args.opts.conversationId,
      agentType: args.opts.agentType,
      deviceId: args.opts.deviceId,
      stellaAppDir: args.opts.stellaAppDir,
      toolWorkspaceRoot: args.opts.toolWorkspaceRoot,
      agentDepth: args.opts.agentContext.agentDepth ?? 0,
      maxAgentDepth: args.opts.agentContext.maxAgentDepth,
      modelConfigSnapshot: args.opts.agentContext.modelConfigSnapshot,
      connectorDeliveryTarget: args.opts.connectorDeliveryTarget,
      allowedToolNames: args.opts.agentContext.toolsAllowlist,
      store: args.opts.store,
      toolExecutor: args.opts.toolExecutor,
      hookEmitter: args.opts.hookEmitter,
      signal,
      onUpdate,
    });
    responseTargetTracker?.noteToolEnd(toolName, toolResult.details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId,
        toolName,
        result: toolResult,
        details: toolResult.details,
      }),
    );
    const sanitizedToolResult = sanitizeSensitiveData(toolResult) as ToolResult;
    persistThreadPayloadMessage(args.opts.store, {
      threadKey,
      payload: {
        role: "toolResult",
        toolCallId,
        toolName,
        content: await buildToolResultContent(
          sanitizedToolResult,
          imageCapTarget,
        ),
        isError: Boolean(toolResult.error),
        timestamp: now(),
      },
    });
    return toolResult;
  };
  const emitCodexCommandExecution = (
    activity: CodexCommandExecutionActivity,
  ) => {
    const toolName = "exec_command";
    const toolArgs = {
      command: activity.command,
      ...(activity.cwd ? { cwd: activity.cwd } : {}),
      state: activity.status,
    };
    if (activity.status === "inProgress") {
      responseTargetTracker?.noteToolStart(toolName, toolArgs);
      args.callbacks?.onToolStart?.(
        runEvents.recordToolStart({
          toolCallId: activity.id,
          toolName,
          statusText: "Running command",
          toolArgs,
        }),
      );
      return;
    }
    const details = {
      ...toolArgs,
      ...(activity.exitCode !== undefined
        ? { exitCode: activity.exitCode }
        : {}),
      codexBuiltinCommandExecution: true,
    };
    responseTargetTracker?.noteToolEnd(toolName, details);
    args.callbacks?.onToolEnd?.(
      runEvents.recordToolEnd({
        toolCallId: activity.id,
        toolName,
        result: {
          state: activity.status,
          ...(activity.exitCode !== undefined
            ? { exitCode: activity.exitCode }
            : {}),
        },
        details,
      }),
    );
  };
  // Codex never receives the full Stella-history block, so the out-of-band
  // delta (managed-child reports, task updates) is injected on every turn —
  // first and resumed alike — keyed off the codex-scoped delivered
  // watermark. An engine takeover reads no watermark (different namespace),
  // so the first Codex turn delivers every row the Codex session has never
  // seen, including reports previously delivered only to Claude.
  const initialDeliveredEntryId = getExternalDeliveredEntryId({
    store: args.opts.store,
    threadKey,
    engine: "codex_cli",
  });
  const threadUpdatesDelta = buildExternalThreadUpdatesDelta({
    store: args.opts.store,
    threadKey,
    ...(initialDeliveredEntryId
      ? { afterEntryId: initialDeliveredEntryId }
      : {}),
    promptMessages: args.promptMessages,
  });
  let deliveredEntryWatermark =
    threadUpdatesDelta.lastEntryId ?? initialDeliveredEntryId;
  const prompt = buildCodexPromptFromMessages({
    promptMessages: threadUpdatesDelta.message
      ? [threadUpdatesDelta.message, ...args.promptMessages]
      : args.promptMessages,
  });
  const inheritedCodexConfig =
    args.opts.agentContext.modelConfigSnapshot?.engine === "codex_cli"
      ? args.opts.agentContext.modelConfigSnapshot
      : undefined;
  const codexModelOverride =
    inheritedCodexConfig?.engineModel ??
    (args.opts.agentContext.spawnEngine?.engine === "codex_cli"
      ? args.opts.agentContext.spawnEngine.model
      : undefined);
  const codexReasoningEffort =
    inheritedCodexConfig?.reasoningEffort ??
    args.opts.agentContext.spawnReasoningEffort;
  let finalResult = await runCodexAgentTurn({
    runId,
    sessionKey,
    ...(persistedSessionId ? { persistedSessionId } : {}),
    prompt,
    systemPrompt: args.systemPrompt,
    cwd: localCliCwd,
    stellaDataDir: args.opts.stellaDataDir,
    stellaAppDir: args.opts.stellaAppDir,
    ...(args.opts.cliBridgeSocketPath
      ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
      : {}),
    stellaModel: args.opts.agentContext.model,
    // Exact inherited Manager route or per-spawn Codex pin.
    ...(codexModelOverride ? { modelOverride: codexModelOverride } : {}),
    ...(codexReasoningEffort
      ? {
          reasoningEffort: codexReasoningEffort,
          ...(inheritedCodexConfig ? { reasoningEffortResolved: true } : {}),
        }
      : {}),
    attachments: args.opts.attachments,
    abortSignal: args.opts.abortSignal,
    onStatus: (status) => {
      args.opts.onProgress?.(status);
      args.callbacks?.onStatus?.(runEvents.recordStatus(status));
    },
    onReasoning: (chunk) => {
      args.callbacks?.onReasoning?.(runEvents.recordReasoning(chunk));
    },
    onCommandExecution: emitCodexCommandExecution,
    onCommentaryStream: acceptCodexAssistantChunk,
    onNativeToolStart: flushPreambleBeforeTool,
    onStream: acceptCodexAssistantChunk,
    onSessionId: persistCodexSessionId,
    onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
    executeTool: executeCodexTool,
    reuseAppServer: true,
    streamFinalAnswer: args.session.kind === "orchestrator",
  });
  assistantUpdateBuffer.discard();

  for (;;) {
    const queued = args.liveAgent?.drain() ?? [];
    if (queued.length === 0) {
      break;
    }
    const queuedStarted = runEvents.recordQueuedUserMessageStart();
    if (queuedStarted) {
      args.callbacks?.onRunStarted?.(queuedStarted);
    }
    const queuedPromptMessages = queued.map(formatQueuedClaudeMessage);
    const queuedAttachments = attachmentsFromQueuedMessages(queued);
    // Rows persisted while this turn was running, offset from the in-turn
    // watermark so nothing sent by the main prompt repeats.
    const queuedThreadUpdatesDelta = buildExternalThreadUpdatesDelta({
      store: args.opts.store,
      threadKey,
      ...(deliveredEntryWatermark
        ? { afterEntryId: deliveredEntryWatermark }
        : {}),
      promptMessages: queuedPromptMessages,
    });
    deliveredEntryWatermark =
      queuedThreadUpdatesDelta.lastEntryId ?? deliveredEntryWatermark;
    const queuedPrompt = buildCodexPromptFromMessages({
      promptMessages: queuedThreadUpdatesDelta.message
        ? [queuedThreadUpdatesDelta.message, ...queuedPromptMessages]
        : queuedPromptMessages,
    });
    finalResult = await runCodexAgentTurn({
      runId,
      sessionKey,
      persistedSessionId: finalResult.sessionId,
      prompt: queuedPrompt,
      systemPrompt: args.systemPrompt,
      cwd: localCliCwd,
      stellaDataDir: args.opts.stellaDataDir,
      stellaAppDir: args.opts.stellaAppDir,
      ...(args.opts.cliBridgeSocketPath
        ? { cliBridgeSocketPath: args.opts.cliBridgeSocketPath }
        : {}),
      stellaModel: args.opts.agentContext.model,
      ...(codexModelOverride ? { modelOverride: codexModelOverride } : {}),
      ...(codexReasoningEffort
        ? {
            reasoningEffort: codexReasoningEffort,
            ...(inheritedCodexConfig ? { reasoningEffortResolved: true } : {}),
          }
        : {}),
      attachments: queuedAttachments,
      abortSignal: args.opts.abortSignal,
      onStatus: (status) => {
        args.opts.onProgress?.(status);
        args.callbacks?.onStatus?.(runEvents.recordStatus(status));
      },
      onReasoning: (chunk) => {
        args.callbacks?.onReasoning?.(runEvents.recordReasoning(chunk));
      },
      onCommandExecution: emitCodexCommandExecution,
      onCommentaryStream: acceptCodexAssistantChunk,
      onNativeToolStart: flushPreambleBeforeTool,
      onStream: acceptCodexAssistantChunk,
      onSessionId: persistCodexSessionId,
      onToolUpdate: ({ update }) => emitToolUpdateStatus(update),
      executeTool: executeCodexTool,
      reuseAppServer: true,
      streamFinalAnswer: args.session.kind === "orchestrator",
    });
    assistantUpdateBuffer.discard();
  }

  await persistAssistantReply({
    store: args.opts.store,
    threadKey,
    resolvedLlm: args.opts.resolvedLlm,
    agentType: args.opts.agentType,
    content: finalResult.text,
    stellaDataDir: args.opts.stellaDataDir,
  });
  const assistantMessageEvent = runEvents.recordAssistantTextEnd(
    finalResult.text,
  );
  if (assistantMessageEvent) {
    args.callbacks?.onAssistantMessage?.(assistantMessageEvent);
  }
  persistCodexSessionId(finalResult.sessionId);
  // Only persisted on success: an aborted/failed turn re-delivers the same
  // rows next turn (at-least-once) instead of silently dropping them.
  if (
    deliveredEntryWatermark &&
    deliveredEntryWatermark !== initialDeliveredEntryId
  ) {
    setExternalDeliveredEntryId({
      store: args.opts.store,
      threadKey,
      engine: "codex_cli",
      entryId: deliveredEntryWatermark,
    });
  }

  return {
    finalText: finalResult.text,
    sessionId: finalResult.sessionId,
    ...(finalResult.fileChanges?.length
      ? { fileChanges: finalResult.fileChanges }
      : {}),
  };
};

export const runExternalOrchestratorTurn = async (
  opts: OrchestratorRunOptions,
): Promise<string | null> => {
  const engine = selectExternalOrchestratorEngine(opts);
  if (!engine) {
    return null;
  }

  // Self-mod baseline capture is performed by the bundled self-mod hook on
  // `before_agent_start`; the matching detect-applied runs on `agent_end`
  // and threads the result onto RuntimeEndEvent.selfModApplied.
  const session = createExternalOrchestratorRunSession(opts, {
    runId: opts.runId ?? `local:${crypto.randomUUID()}`,
  });
  const liveAgent = createExternalLiveAgent();

  try {
    // Thread `session.runId` into the prompt build so the
    // `before_agent_start` hook's payload carries the run id. Without
    // this, the bundled self-mod hook bails (it requires `payload.runId`
    // to key its baseline cache), the cache stays empty, and the
    // matching `agent_end` finds no entry — silently breaking the
    // morph overlay for the Claude Code orchestrator path. The Pi
    // path threads the session runId through `OrchestratorSession.runTurn`
    // already; mirror that here.
    const systemPrompt = await buildRuntimeSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const promptMessages = await buildOrchestratorPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    opts.onExecutionSessionCreated?.({
      runId: session.runId,
      threadKey: session.threadKey,
      engine: "external",
      queueUserMessageId: session.runEvents.queueUserMessageId,
      agent: liveAgent.agent,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
      liveAgent,
    });
    return await session.finalizeSuccess(result.finalText);
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    session.finalizeError(error);
    throw markOrchestratorErrorReported(error);
  } finally {
    liveAgent.finish();
    // The external engine persisted this turn's user + assistant messages to
    // the shared durable thread but ran entirely outside the held-over Pi
    // `OrchestratorSession`, so that session's in-memory `state.messages`
    // still reflects only its own prior turns. Flag it for a history refresh
    // so a later default-engine turn on this conversation re-syncs from the
    // store instead of prompting with stale context that omits these Claude
    // Code turns. Mirrors how realtime voice — another out-of-band writer to
    // the same thread — calls `notifyHistoryChanged()`. No-op when no live Pi
    // agent exists yet (it seeds fresh from the store on first construction).
    opts.orchestratorSession?.notifyHistoryChanged();
  }
};

export const runExternalSubagentTurn = async (
  opts: SubagentRunOptions,
): Promise<SubagentRunResult | null> => {
  if (!shouldUseClaudeCodeRuntime(opts)) {
    const useCodex = shouldUseCodexAgentRuntime({
      agentType: opts.agentType,
      agentEngine: opts.agentContext.agentEngine,
    });
    if (!useCodex) {
      return null;
    }

    const session = createExternalSubagentRunSession(opts, {
      runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
    });

    try {
      const promptMessages = await buildSubagentPromptMessages({
        context: opts.agentContext,
        userPrompt: opts.userPrompt,
        promptMessages: opts.promptMessages,
        stellaDataDir: opts.stellaDataDir,
        stellaAppDir: opts.stellaAppDir,
        agentType: opts.agentType,
        hookContext: {
          ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
          conversationId: opts.conversationId,
          threadKey: session.threadKey,
          runId: session.runId,
          ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
        },
      });
      const systemPrompt = await buildSubagentSystemPrompt({
        ...opts,
        runId: session.runId,
      });
      const result = await runCodexHostedTurn({
        opts,
        session,
        systemPrompt,
        promptMessages,
        callbacks: opts.callbacks,
      });
      const finalized = await session.finalizeSuccess(result.finalText);
      if (result.fileChanges?.length) {
        finalized.fileChanges = result.fileChanges;
      }
      return finalized;
    } catch (error) {
      const interruptedReason = resolveInterruptionReason({
        abortSignal: opts.abortSignal,
        error,
      });
      if (interruptedReason) {
        return session.finalizeInterrupted(interruptedReason);
      }
      return session.finalizeError(error);
    }
  }

  const session = createExternalSubagentRunSession(opts, {
    runId: opts.runId ?? `local:sub:${crypto.randomUUID()}`,
  });

  try {
    const promptMessages = await buildSubagentPromptMessages({
      context: opts.agentContext,
      userPrompt: opts.userPrompt,
      promptMessages: opts.promptMessages,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      agentType: opts.agentType,
      hookContext: {
        ...(opts.hookEmitter ? { hookEmitter: opts.hookEmitter } : {}),
        conversationId: opts.conversationId,
        threadKey: session.threadKey,
        runId: session.runId,
        ...(opts.uiVisibility ? { uiVisibility: opts.uiVisibility } : {}),
      },
    });
    // Thread session.runId so a future `triggersSelfModDetection`
    // subagent (none today) would have the same baseline-capture
    // wiring as the orchestrator.
    const systemPrompt = await buildSubagentSystemPrompt({
      ...opts,
      runId: session.runId,
    });
    const result = await runClaudeHostedTurn({
      opts,
      session,
      systemPrompt,
      promptMessages,
      callbacks: opts.callbacks,
    });
    const finalized = await session.finalizeSuccess(result.finalText);
    // Vanilla-mode Claude Code executes its own file tools, so no Stella
    // tool-end events carry these writes — surface them on the run result
    // (same contract as the Codex branch above) so the agent-completed
    // rollup and the chat finish card get the produced artifacts.
    if (result.fileChanges?.length) {
      finalized.fileChanges = result.fileChanges;
    }
    return finalized;
  } catch (error) {
    const interruptedReason = resolveInterruptionReason({
      abortSignal: opts.abortSignal,
      error,
    });
    if (interruptedReason) {
      return session.finalizeInterrupted(interruptedReason);
    }
    return session.finalizeError(error);
  }
};

export const shutdownExternalEngineIntegrations = (): void => {
  shutdownClaudeCodeRuntime();
  shutdownCodexAppServerRuntime();
};
