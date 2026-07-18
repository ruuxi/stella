import path from "node:path";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
} from "../../ai/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadCustomMessageEntry,
} from "../storage/shared.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { createRuntimeLogger } from "../debug.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { RuntimePromptMessage } from "../../protocol/index.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { now } from "./shared.js";
import type { AgentMessage } from "../agent-core/types.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import { redactMemoryText } from "../memory/redaction.js";

const logger = createRuntimeLogger("agent-runtime.thread-memory");
const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
const LIFE_MEMORY_SUMMARY_DISPLAY_PATH = "~/.stella/memories/memory_summary.md";
const MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS = 12_000;
const MEMORY_SUMMARY_TRUNCATION_MARKER =
  "\n...[resident memory summary truncated]";
const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";
export const buildRunThreadKey = ({
  conversationId,
  agentType,
  runId,
  threadId,
}: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}): string =>
  buildRuntimeThreadKey({
    conversationId,
    agentType,
    runId,
    threadId,
  });

// Retention budget for tool-result images in model history, newest first.
// The old policy kept exactly ONE image-bearing message, which made
// multi-image work impossible: viewing 5 reference images left 4 as
// "re-run the tool" placeholders on the very next LLM call, and every
// re-view evicted the previous image. Budgets are accounted per image
// block (a batched view counts each image), sized so screenshot loops
// stay cheap while a set of downscaled reference images survives across
// turns without busting the managed relay's ~20MiB request cap.
const MAX_IMAGES_IN_HISTORY = 8;
const IMAGE_HISTORY_BASE64_BUDGET = 12 * 1024 * 1024;

export const stripStaleImageBlocks = <T extends { role: string }>(
  messages: T[],
): T[] => {
  let imagesKept = 0;
  let imageBytesKept = 0;
  let rewroteAny = false;
  const out: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") {
      out.push(message);
      continue;
    }
    const toolResult = message as unknown as {
      content: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    const hasImage = toolResult.content.some((block) => block.type === "image");
    if (!hasImage) {
      out.push(message);
      continue;
    }
    let rewroteThisMessage = false;
    // Within a message, newest-last ordering doesn't matter much; account
    // blocks in reverse so the budget favors the same blocks the loop
    // direction favors across messages.
    const compactContent = [...toolResult.content]
      .reverse()
      .map((block) => {
        if (block.type !== "image") {
          return block;
        }
        const base64Bytes = block.data?.length ?? 0;
        if (
          imagesKept < MAX_IMAGES_IN_HISTORY &&
          imageBytesKept + base64Bytes <= IMAGE_HISTORY_BASE64_BUDGET
        ) {
          imagesKept += 1;
          imageBytesKept += base64Bytes;
          return block;
        }
        rewroteThisMessage = true;
        const sizeKb = Math.round((base64Bytes * 0.75) / 1024);
        return {
          type: "text",
          text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
        };
      })
      .reverse();
    if (!rewroteThisMessage) {
      out.push(message);
      continue;
    }
    rewroteAny = true;
    out.push({
      ...(message as object),
      content: compactContent,
    } as unknown as T);
  }
  return rewroteAny ? out.reverse() : messages;
};

export const buildHistorySource = (
  context: LocalAgentContext,
): AgentMessage[] => {
  // Keep older bootstrap entries so cadence injections do not shift the
  // prompt-cache prefix on coast turns.
  const messages =
    context.threadHistory
      ?.map((entry): AgentMessage | null => {
        if (entry.payload) {
          return toRuntimeMessage(entry.payload);
        }
        if (entry.role === "runtimeInternal" && entry.customMessage) {
          return {
            role: "runtimeInternal",
            content: entry.customMessage.content,
            timestamp: entry.timestamp ?? now(),
            customType: entry.customMessage.customType,
            display: entry.customMessage.display,
          } satisfies AgentMessage;
        }
        if (entry.role === "user" && typeof entry.content === "string") {
          return {
            role: "user",
            content: entry.content,
            timestamp: now(),
          } satisfies UserMessage;
        }
        if (entry.role === "assistant" && typeof entry.content === "string") {
          const trimmed = entry.content.trim();
          if (!trimmed) return null;
          return createHistoryAssistantMessage([
            { type: "text", text: trimmed } satisfies TextContent,
          ]);
        }
        if (
          entry.role === "runtimeInternal" &&
          typeof entry.content === "string"
        ) {
          const trimmed = entry.content.trim();
          if (!trimmed) return null;
          return {
            role: "runtimeInternal",
            content: [{ type: "text", text: trimmed }],
            timestamp: now(),
          } satisfies AgentMessage;
        }
        return null;
      })
      .filter((entry): entry is AgentMessage => entry !== null) ?? [];
  return stripStaleImageBlocks(messages);
};

const createHistoryAssistantMessage = (
  content: (TextContent | ThinkingContent | ToolCall)[],
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openai",
  model: "history",
  usage: {
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
  },
  stopReason: "stop",
  ...(errorMessage ? { errorMessage } : {}),
  timestamp: now(),
});

const toRuntimeMessage = (
  payload: PersistedRuntimeThreadPayload,
): Message | null => {
  if (payload.role === "user") {
    return payload;
  }
  if (payload.role === "assistant") {
    const trimmedContent: (TextContent | ThinkingContent | ToolCall)[] = [];
    for (const block of payload.content) {
      if (block.type !== "text") {
        trimmedContent.push(block);
        continue;
      }
      const trimmed = block.text.trim();
      if (trimmed) {
        trimmedContent.push({ ...block, text: trimmed });
      }
    }
    return {
      ...payload,
      content: trimmedContent,
    };
  }
  return payload;
};

const stringifyPayload = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const contentPreviewFromTextAndImages = (
  content: (TextContent | ImageContent)[],
): string =>
  content
    .map((block) =>
      block.type === "text" ? block.text : `[Image: ${block.mimeType}]`,
    )
    .join("\n")
    .trim();

export const buildThreadMessagePreview = (
  payload: PersistedRuntimeThreadPayload,
): string => {
  if (payload.role === "user") {
    return typeof payload.content === "string"
      ? payload.content
      : contentPreviewFromTextAndImages(payload.content);
  }
  if (payload.role === "assistant") {
    return payload.content
      .flatMap((block) => {
        if (block.type === "text") {
          const trimmed = block.text.trim();
          return trimmed ? [trimmed] : [];
        }
        if (block.type === "toolCall") {
          return [
            `[Tool call] ${block.name}\nargs: ${stringifyPayload(block.arguments ?? {})}`,
          ];
        }
        return [];
      })
      .join("\n\n")
      .trim();
  }
  const body = contentPreviewFromTextAndImages(payload.content);
  return [`[Tool result] ${payload.toolName}`, ...(body ? [body] : [])]
    .join("\n")
    .trim();
};

export const persistThreadPayloadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    payload: PersistedRuntimeThreadPayload;
    runId?: string;
    attemptGeneration?: number;
  },
): void => {
  const payload =
    args.payload.role === "assistant"
      ? ({
          ...args.payload,
          ...(args.runId ? { stellaRunId: args.runId } : {}),
          ...(typeof args.attemptGeneration === "number"
            ? { stellaAttemptGeneration: args.attemptGeneration }
            : {}),
        } as PersistedRuntimeThreadPayload)
      : args.payload;
  const preview = buildThreadMessagePreview(payload);
  const toolCallId =
    payload.role === "toolResult" ? payload.toolCallId : undefined;
  appendThreadMessage(store, {
    threadKey: args.threadKey,
    role: payload.role,
    content: preview,
    ...(toolCallId ? { toolCallId } : {}),
    payload,
  });
};

export const persistThreadCustomMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    customType: string;
    content: RuntimeThreadCustomMessageEntry["content"];
    display?: boolean;
    timestamp?: number;
    eventId?: string;
  },
): void => {
  store.appendThreadCustomMessage({
    threadKey: args.threadKey,
    timestamp: args.timestamp ?? now(),
    customType: args.customType,
    content: args.content,
    display: args.display === true,
    ...(args.eventId ? { eventId: args.eventId } : {}),
  });
};

const getPlatformShellPrompt = (): string | null => {
  if (process.platform === "win32") {
    return "On Windows, use the native command shell and Windows paths. Prefer PowerShell when it is the clearer fit for the task.";
  }
  if (process.platform === "darwin") {
    return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
  }
  return null;
};

const hasToolGuidance = (
  context: LocalAgentContext,
  toolNames: string[],
): boolean => {
  const toolsAllowlist = context.toolsAllowlist;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return true;
  }
  return toolNames.some((toolName) => toolsAllowlist.includes(toolName));
};

const hasShellToolGuidance = (context: LocalAgentContext): boolean => {
  return hasToolGuidance(context, ["Bash", "exec_command"]);
};

const buildFileEditingPrompt = (context: LocalAgentContext): string | null => {
  const explicitlyHasWriteEdit =
    Array.isArray(context.toolsAllowlist) &&
    context.toolsAllowlist.length > 0 &&
    (context.toolsAllowlist.includes("Write") ||
      context.toolsAllowlist.includes("Edit"));
  if (explicitlyHasWriteEdit) {
    return [
      "File edits:",
      "- Use `Write` for new files or full-file replacements.",
      "- Use `Edit` for targeted text replacements inside existing files.",
      "- Use `exec_command` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
      "- Do not use shell heredocs or `cat > file` for source edits when `Write` or `Edit` can express the change.",
    ].join("\n");
  }

  if (!hasToolGuidance(context, ["apply_patch"])) {
    return null;
  }

  return [
    "File edits:",
    "- Prefer `apply_patch` for source and text-file edits so changes are tracked as structured patches.",
    "- Use `exec_command` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
    "- Do not use shell heredocs or `cat > file` for source edits when `apply_patch` can express the change.",
  ].join("\n");
};

export const buildSystemPrompt = (context: LocalAgentContext): string => {
  const sections = [context.systemPrompt.trim()];

  if (context.dynamicContext?.trim()) {
    sections.push(context.dynamicContext.trim());
  }

  const fileEditingPrompt = buildFileEditingPrompt(context);
  if (fileEditingPrompt) {
    sections.push(fileEditingPrompt);
  }

  const platformShellPrompt = getPlatformShellPrompt();
  if (platformShellPrompt && hasShellToolGuidance(context)) {
    sections.push(platformShellPrompt);
  }

  return sections.filter(Boolean).join("\n\n");
};

const buildStartupDocMessage = (
  displayPath: string,
  content: string,
): string => {
  return [
    `<startup_doc path="${displayPath}">`,
    content,
    "</startup_doc>",
  ].join("\n");
};

export const isBootstrapStartupDocMessage = (
  message: Pick<AgentMessage, "role"> & { customType?: string },
): boolean =>
  message.role === "runtimeInternal" &&
  message.customType === BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE;

const customMessageContentText = (
  content: RuntimeThreadCustomMessageEntry["content"],
): string => {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
};

const hasPersistedStartupDoc = (
  context: LocalAgentContext,
  docText: string,
): boolean => {
  const needle = docText.trim();
  return (
    context.threadHistory?.some((entry) => {
      const customMessage = entry.customMessage;
      if (
        entry.role !== "runtimeInternal" ||
        customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE
      ) {
        return false;
      }
      // Match on the full doc body, not just its path. A resident doc whose
      // content changed mid-thread (a Remember replace/remove, or Dream
      // refreshing memory_summary.md) must re-inject so the thread sees the
      // current version instead of the stale copy already in history.
      return customMessageContentText(customMessage.content).trim() === needle;
    }) ?? false
  );
};

export type OrchestratorPromptMessage = RuntimePromptMessage;

const createInternalPromptMessage = (
  text: string,
  uiVisibility: "visible" | "hidden" = "hidden",
  customType?: string,
): RuntimePromptMessage => ({
  text,
  uiVisibility,
  messageType: "message",
  ...(customType ? { customType } : {}),
});

const readRegistryContent = async (args: {
  stellaDataDir?: string;
}): Promise<string | null> => {
  const stellaDataDir = args.stellaDataDir?.trim();
  if (!stellaDataDir) {
    return null;
  }
  return await readOptionalTextFile(path.join(stellaDataDir, "registry.md"));
};

export const buildStartupPromptMessages = async (args: {
  context: LocalAgentContext;
  stellaDataDir?: string;
  stellaAppDir?: string;
  includeRegistry?: boolean;
}): Promise<RuntimePromptMessage[]> => {
  const messages: RuntimePromptMessage[] = [];
  const shouldIncludeRegistry = args.includeRegistry ?? false;

  const personality = args.context.personality?.trim();
  if (personality) {
    const doc = buildStartupDocMessage(
      LIFE_PERSONALITY_DISPLAY_PATH,
      personality,
    );
    if (!hasPersistedStartupDoc(args.context, doc)) {
      messages.push(
        createInternalPromptMessage(
          doc,
          "hidden",
          BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
        ),
      );
    }
  }

  if (shouldIncludeRegistry) {
    const registryContent = await readRegistryContent({
      stellaDataDir: args.stellaDataDir,
    });
    if (registryContent) {
      const doc = buildStartupDocMessage(
        LIFE_REGISTRY_DISPLAY_PATH,
        registryContent,
      );
      if (!hasPersistedStartupDoc(args.context, doc)) {
        messages.push(
          createInternalPromptMessage(
            doc,
            "hidden",
            BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
          ),
        );
      }
    }
  }

  const coreMemory = args.context.coreMemory
    ? redactMemoryText(args.context.coreMemory.trim())
    : "";
  if (coreMemory) {
    const doc = buildStartupDocMessage(
      LIFE_CORE_MEMORY_DISPLAY_PATH,
      coreMemory,
    );
    if (!hasPersistedStartupDoc(args.context, doc)) {
      messages.push(
        createInternalPromptMessage(
          doc,
          "hidden",
          BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
        ),
      );
    }
  }

  // Resident user profile — durable facts the Remember tool persists. Pushed
  // every session so identity facts ("the user goes by Bob") are always in
  // context without a Context lookup.
  const userProfile = args.context.userProfile
    ? redactMemoryText(args.context.userProfile.trim())
    : "";
  if (userProfile) {
    const doc = buildStartupDocMessage(
      LIFE_USER_PROFILE_DISPLAY_PATH,
      userProfile,
    );
    if (!hasPersistedStartupDoc(args.context, doc)) {
      messages.push(
        createInternalPromptMessage(
          doc,
          "hidden",
          BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
        ),
      );
    }
  }

  // Resident focus summary — Dream's dynamic snapshot of what the user is
  // actively working on, now pushed instead of only reachable via Context.
  const rawMemorySummary = args.context.memorySummary
    ? redactMemoryText(args.context.memorySummary.trim())
    : "";
  const memorySummary =
    rawMemorySummary.length > MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS
      ? `${rawMemorySummary.slice(
          0,
          MEMORY_SUMMARY_BOOTSTRAP_MAX_CHARS -
            MEMORY_SUMMARY_TRUNCATION_MARKER.length,
        )}${MEMORY_SUMMARY_TRUNCATION_MARKER}`
      : rawMemorySummary;
  if (memorySummary) {
    const doc = buildStartupDocMessage(
      LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
      memorySummary,
    );
    if (!hasPersistedStartupDoc(args.context, doc)) {
      messages.push(
        createInternalPromptMessage(
          doc,
          "hidden",
          BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
        ),
      );
    }
  }

  return messages;
};

/**
 * Hook context fields passed to the `before_user_message` emitter.
 * Optional because direct test callers and external engines can build
 * prompt messages without a hook emitter; in that case the hook fan-out
 * is skipped and the kernel produces a bundled-startup-only prompt.
 */
export type PromptHookContext = {
  hookEmitter?: HookEmitter;
  conversationId?: string;
  threadKey?: string;
  runId?: string;
  uiVisibility?: "visible" | "hidden";
};

const fanOutBeforeUserMessage = async (args: {
  hookContext: PromptHookContext;
  agentType: string;
  userPrompt: string;
  staleUserReminderText?: string;
  orchestratorReminderText?: string;
  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
}): Promise<{
  prepend: RuntimePromptMessage[];
  append: RuntimePromptMessage[];
}> => {
  const empty = { prepend: [], append: [] };
  const { hookEmitter } = args.hookContext;
  if (!hookEmitter) return empty;
  const results = await hookEmitter.emitAll(
    "before_user_message",
    {
      agentType: args.agentType,
      userPrompt: args.userPrompt,
      ...(args.staleUserReminderText !== undefined
        ? { staleUserReminderText: args.staleUserReminderText }
        : {}),
      ...(args.orchestratorReminderText !== undefined
        ? { orchestratorReminderText: args.orchestratorReminderText }
        : {}),
      ...(args.connectorTransitionReminderText !== undefined
        ? {
            connectorTransitionReminderText:
              args.connectorTransitionReminderText,
          }
        : {}),
      ...(args.shouldInjectDynamicReminder !== undefined
        ? { shouldInjectDynamicReminder: args.shouldInjectDynamicReminder }
        : {}),
      ...(args.hookContext.conversationId
        ? { conversationId: args.hookContext.conversationId }
        : {}),
      ...(args.hookContext.threadKey
        ? { threadKey: args.hookContext.threadKey }
        : {}),
      ...(args.hookContext.runId ? { runId: args.hookContext.runId } : {}),
      ...(args.hookContext.uiVisibility
        ? { uiVisibility: args.hookContext.uiVisibility }
        : {}),
      isUserTurn: args.hookContext.uiVisibility !== "hidden",
    },
    { agentType: args.agentType },
  );
  const prepend: RuntimePromptMessage[] = [];
  const append: RuntimePromptMessage[] = [];
  for (const result of results) {
    if (result?.prependMessages?.length) {
      prepend.push(...result.prependMessages);
    }
    if (result?.appendMessages?.length) {
      append.push(...result.appendMessages);
    }
  }
  return { prepend, append };
};

export const buildSubagentPromptMessages = async (args: {
  context: LocalAgentContext;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  stellaDataDir?: string;
  stellaAppDir?: string;
  agentType?: string;
  hookContext?: PromptHookContext;
}): Promise<RuntimePromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const messages: RuntimePromptMessage[] = [];

  // `before_user_message` fan-out runs first so extension-injected
  // context lands at the very top of the prompt-message array.
  // Subagent reminder fields are intentionally undefined — they're an
  // orchestrator-only concept on `LocalAgentContext` today.
  if (args.agentType && args.hookContext) {
    const { prepend, append } = await fanOutBeforeUserMessage({
      hookContext: args.hookContext,
      agentType: args.agentType,
      userPrompt: args.userPrompt,
    });
    messages.push(...prepend);
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
    messages.push(...append);
  } else {
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
  }

  if (args.promptMessages?.length) {
    messages.push(...args.promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: args.userPrompt });
  }
  return messages;
};

export const buildOrchestratorPromptMessages = async (args: {
  context: LocalAgentContext;
  userPrompt: string;
  promptMessages?: OrchestratorPromptMessage[];
  stellaDataDir?: string;
  stellaAppDir?: string;
  agentType?: string;
  hookContext?: PromptHookContext;
}): Promise<OrchestratorPromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const messages: OrchestratorPromptMessage[] = [];

  // Stale-user / dynamic-memory reminders used to be inline branches
  // here; they now live as `before_user_message` hooks in
  // `runtime/extensions/stella-runtime/hooks/`. The reminder text is
  // forwarded through the hook payload so the hooks can decide whether
  // to inject. When no hook emitter is wired (legacy / direct test
  // callers) the prompt builds without reminders, matching the
  // pre-migration behavior for those callers.
  if (args.agentType && args.hookContext) {
    const { prepend, append } = await fanOutBeforeUserMessage({
      hookContext: args.hookContext,
      agentType: args.agentType,
      userPrompt: args.userPrompt,
      ...(args.context.staleUserReminderText !== undefined
        ? { staleUserReminderText: args.context.staleUserReminderText }
        : {}),
      ...(args.context.orchestratorReminderText !== undefined
        ? { orchestratorReminderText: args.context.orchestratorReminderText }
        : {}),
      ...(args.context.connectorTransitionReminderText !== undefined
        ? {
            connectorTransitionReminderText:
              args.context.connectorTransitionReminderText,
          }
        : {}),
      ...(args.context.shouldInjectDynamicReminder !== undefined
        ? {
            shouldInjectDynamicReminder:
              args.context.shouldInjectDynamicReminder,
          }
        : {}),
    });
    messages.push(...prepend);
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
    messages.push(...append);
  } else {
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
  }

  if (args.promptMessages?.length) {
    messages.push(...args.promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: args.userPrompt });
  }
  return messages;
};

export const updateOrchestratorReminderState = (
  store: RuntimeStore,
  args: {
    conversationId: string;
    shouldInjectDynamicReminder?: boolean;
    finalText: string;
  },
): void => {
  const updateCounter = (
    store as RuntimeStore & {
      updateOrchestratorReminderCounter?: (args: {
        conversationId: string;
        resetTo?: number;
        incrementBy?: number;
      }) => void;
    }
  ).updateOrchestratorReminderCounter;
  if (typeof updateCounter !== "function") {
    return;
  }
  if (args.shouldInjectDynamicReminder) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      resetTo: 0,
    });
  }
};

export const appendThreadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    role: "user" | "assistant" | "toolResult";
    content: string;
    toolCallId?: string;
    payload?: PersistedRuntimeThreadPayload;
  },
): void => {
  store.appendThreadMessage({
    timestamp: now(),
    threadKey: args.threadKey,
    role: args.role,
    content: args.content,
    ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    ...(args.payload ? { payload: args.payload } : {}),
  });
};

export const compactRuntimeThreadHistory = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  overrideSummary?: string;
  preserveLastN?: number;
  stellaDataDir?: string;
}): Promise<{ compacted: boolean }> => {
  try {
    return await maybeCompactRuntimeThread({
      store: args.store,
      threadKey: args.threadKey,
      resolvedLlm: args.resolvedLlm,
      agentType: args.agentType,
      ...(args.overrideSummary
        ? { overrideSummary: args.overrideSummary }
        : {}),
      ...(args.preserveLastN !== undefined
        ? { preserveLastN: args.preserveLastN }
        : {}),
      ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
    });
  } catch (error) {
    logger.warn("thread.compaction.failed", {
      threadKey: args.threadKey,
      agentType: args.agentType,
      error: error instanceof Error ? error.message : String(error),
    });
    return { compacted: false };
  }
};

export const persistAssistantReply = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  content: string;
  stellaDataDir?: string;
}): Promise<void> => {
  if (!args.content.trim()) {
    return;
  }
  appendThreadMessage(args.store, {
    threadKey: args.threadKey,
    role: "assistant",
    content: args.content,
  });
  await compactRuntimeThreadHistory(args);
};
