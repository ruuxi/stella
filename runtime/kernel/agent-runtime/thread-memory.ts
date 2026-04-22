import fs from "node:fs/promises";
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
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimePromptMessage } from "../../protocol/index.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { wrapSystemReminder } from "../message-timestamp.js";
import { now } from "./shared.js";

const logger = createRuntimeLogger("agent-runtime.thread-memory");
const LIFE_REGISTRY_DISPLAY_PATH = "state/registry.md";
const LIFE_CORE_MEMORY_DISPLAY_PATH = "state/core-memory.md";

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

// Vision tool results (computer_get_app_state, view_image, etc.) carry a
// base64-encoded image content block on every snapshot. Each PNG is roughly
// 700KB raw → ~1MB base64 → another ~1MB after JSON encoding when sent to
// the model. After a handful of turns the conversation history balloons
// past the upstream LLM proxy's per-request memory cap (Convex throws
// "JavaScript execution ran out of memory (maximum 64 MB)").
//
// The model only needs to *see* the most recent screenshot to act; older
// screenshots have already informed the actions that followed them and
// just bloat the prompt. So before sending history to the model we keep
// image content blocks ONLY in the most recent N tool results, replacing
// older image blocks with a tiny text breadcrumb that preserves provenance
// (the screenshot file path is still on disk if anything ever needs it).
const KEEP_RECENT_IMAGES_IN_HISTORY = 1;

const stripStaleImageBlocks = (messages: Message[]): Message[] => {
  let imagesKept = 0;
  const out: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "toolResult") {
      out.push(message);
      continue;
    }
    const hasImage = message.content.some((block) => block.type === "image");
    if (!hasImage) {
      out.push(message);
      continue;
    }
    if (imagesKept < KEEP_RECENT_IMAGES_IN_HISTORY) {
      imagesKept += 1;
      out.push(message);
      continue;
    }
    const compactContent = message.content.map((block) => {
      if (block.type !== "image") {
        return block;
      }
      const sizeKb = Math.round(((block.data?.length ?? 0) * 0.75) / 1024);
      return {
        type: "text" as const,
        text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
      };
    });
    out.push({ ...message, content: compactContent });
  }
  return out.reverse();
};

export const buildHistorySource = (
  context: LocalTaskManagerAgentContext,
): Message[] => {
  const messages =
    context.threadHistory
      ?.map((entry) => {
        if (entry.payload) {
          return toRuntimeMessage(entry.payload);
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
        return null;
      })
      .filter((entry): entry is Message => entry !== null) ?? [];
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
      block.type === "text"
        ? block.text
        : `[Image: ${block.mimeType}]`,
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
  return [
    `[Tool result] ${payload.toolName}`,
    ...(body ? [body] : []),
  ].join("\n").trim();
};

export const persistThreadPayloadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    payload: PersistedRuntimeThreadPayload;
  },
): void => {
  const preview = buildThreadMessagePreview(args.payload);
  const toolCallId =
    args.payload.role === "toolResult" ? args.payload.toolCallId : undefined;
  appendThreadMessage(store, {
    threadKey: args.threadKey,
    role: args.payload.role,
    content: preview,
    ...(toolCallId ? { toolCallId } : {}),
    payload: args.payload,
  });
};

const getPlatformShellPrompt = (): string | null => {
  if (process.platform === "win32") {
    return "On Windows, Bash runs in Git Bash. Prefer POSIX commands and /c/... style paths over C:\\ paths when using Bash.";
  }
  if (process.platform === "darwin") {
    return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
  }
  return null;
};

const hasShellToolGuidance = (
  context: LocalTaskManagerAgentContext,
): boolean => {
  const toolsAllowlist = context.toolsAllowlist;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return true;
  }
  return toolsAllowlist.includes("Bash");
};

export const buildSystemPrompt = (
  context: LocalTaskManagerAgentContext,
): string => {
  const sections = [context.systemPrompt.trim()];

  if (context.dynamicContext?.trim()) {
    sections.push(context.dynamicContext.trim());
  }

  const platformShellPrompt = getPlatformShellPrompt();
  if (platformShellPrompt && hasShellToolGuidance(context)) {
    sections.push(platformShellPrompt);
  }

  return sections.filter(Boolean).join("\n\n");
};

export const buildSelfModDocumentationPrompt = (
  stellaRoot?: string,
): string => {
  if (!stellaRoot?.trim()) return "";

  return [
    "Documentation:",
    "- If you are working on renderer structure, file placement, or ownership boundaries, read `src/STELLA.md` first.",
  ].join("\n");
};

const readOptionalTextFile = async (filePath: string): Promise<string | null> => {
  try {
    const content = (await fs.readFile(filePath, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
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

const buildMemoryFileMessage = (
  displayPath: string,
  content: string,
): string => {
  return [
    `<memory_file path="${displayPath}">`,
    content,
    "</memory_file>",
  ].join("\n");
};

const DREAM_MEMORY_DISPLAY_PATH = "state/memories/MEMORY.md";
const DREAM_MEMORY_SUMMARY_DISPLAY_PATH = "state/memories/memory_summary.md";

const injectDreamMemoryFiles = async (args: {
  messages: RuntimePromptMessage[];
  context: LocalTaskManagerAgentContext;
  stellaHome?: string;
  stellaRoot?: string;
  isFirstTurn: boolean;
}): Promise<void> => {
  const home = args.stellaHome?.trim() || args.stellaRoot?.trim();
  if (!home) return;

  const summaryPath = path.join(home, "state", "memories", "memory_summary.md");
  const summary = await readOptionalTextFile(summaryPath);
  if (summary) {
    args.messages.push(
      createInternalPromptMessage(
        buildMemoryFileMessage(DREAM_MEMORY_SUMMARY_DISPLAY_PATH, summary),
        "hidden",
        "bootstrap.memory_file",
      ),
    );
  }

  if (!args.isFirstTurn) return;
  const memoryPath = path.join(home, "state", "memories", "MEMORY.md");
  const memory = await readOptionalTextFile(memoryPath);
  if (memory) {
    args.messages.push(
      createInternalPromptMessage(
        buildMemoryFileMessage(DREAM_MEMORY_DISPLAY_PATH, memory),
        "hidden",
        "bootstrap.memory_file",
      ),
    );
  }
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
  stellaHome?: string;
  stellaRoot?: string;
}): Promise<string | null> => {
  const stellaHome = args.stellaHome?.trim();
  if (stellaHome) {
    const stellaHomeRegistry = await readOptionalTextFile(
      path.join(stellaHome, "state", "registry.md"),
    );
    if (stellaHomeRegistry) {
      return stellaHomeRegistry;
    }
  }

  const stellaRoot = args.stellaRoot?.trim();
  if (!stellaRoot) {
    return null;
  }
  return await readOptionalTextFile(path.join(stellaRoot, "state", "registry.md"));
};

export const buildStartupPromptMessages = async (args: {
  context: LocalTaskManagerAgentContext;
  stellaHome?: string;
  stellaRoot?: string;
  includeDreamMemoryFiles?: boolean;
}): Promise<RuntimePromptMessage[]> => {
  const messages: RuntimePromptMessage[] = [];
  const shouldIncludeStartupDocs = !(args.context.threadHistory?.length);

  if (shouldIncludeStartupDocs) {
    const registryContent = await readRegistryContent({
      stellaHome: args.stellaHome,
      stellaRoot: args.stellaRoot,
    });
    if (registryContent) {
      messages.push(
        createInternalPromptMessage(
          buildStartupDocMessage(LIFE_REGISTRY_DISPLAY_PATH, registryContent),
          "hidden",
          "bootstrap.startup_doc",
        ),
      );
    }

    const coreMemory = args.context.coreMemory?.trim();
    if (coreMemory) {
      messages.push(
        createInternalPromptMessage(
          buildStartupDocMessage(LIFE_CORE_MEMORY_DISPLAY_PATH, coreMemory),
          "hidden",
          "bootstrap.startup_doc",
        ),
      );
    }
  }

  if (args.includeDreamMemoryFiles) {
    // Dream-managed memory files (state/memories/MEMORY.md and
    // memory_summary.md) are injected into the ORCHESTRATOR only. MEMORY.md is
    // bigger and more stable, so we only inject it on the first turn (when
    // there is no thread history). memory_summary.md is small and dynamic, so
    // we inject it on every orchestrator turn.
    await injectDreamMemoryFiles({
      messages,
      context: args.context,
      stellaHome: args.stellaHome,
      stellaRoot: args.stellaRoot,
      isFirstTurn: shouldIncludeStartupDocs,
    });
  }

  // Frozen Memory + User Profile snapshot. Populated only for the Orchestrator
  // by buildAgentContext - General agents do not see the snapshot.
  //
  // Unlike startup docs, we resend this on resumed turns because runtimeInternal
  // bootstrap messages are not persisted in thread history.
  const memorySnapshot = args.context.memorySnapshot;
  if (memorySnapshot) {
    const userBlock = memorySnapshot.user?.trim();
    if (userBlock) {
      messages.push(
        createInternalPromptMessage(
          `<memory_snapshot target="user">\n${userBlock}\n</memory_snapshot>`,
          "hidden",
          "bootstrap.memory_snapshot",
        ),
      );
    }
    const memoryBlock = memorySnapshot.memory?.trim();
    if (memoryBlock) {
      messages.push(
        createInternalPromptMessage(
          `<memory_snapshot target="memory">\n${memoryBlock}\n</memory_snapshot>`,
          "hidden",
          "bootstrap.memory_snapshot",
        ),
      );
    }
  }

  return messages;
};

export const buildSubagentPromptMessages = async (args: {
  context: LocalTaskManagerAgentContext;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  stellaHome?: string;
  stellaRoot?: string;
}): Promise<RuntimePromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const messages = await buildStartupPromptMessages({
    context: args.context,
    stellaHome: args.stellaHome,
    stellaRoot: args.stellaRoot,
    includeDreamMemoryFiles: false,
  });
  if (args.promptMessages?.length) {
    messages.push(...args.promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: args.userPrompt });
  }
  return messages;
};

export const buildOrchestratorPromptMessages = async (args: {
  context: LocalTaskManagerAgentContext;
  userPrompt: string;
  promptMessages?: OrchestratorPromptMessage[];
  stellaHome?: string;
  stellaRoot?: string;
}): Promise<OrchestratorPromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const staleUserReminder = args.context.staleUserReminderText?.trim();
  const reminder = args.context.orchestratorReminderText?.trim();
  const messages: OrchestratorPromptMessage[] = [];
  if (staleUserReminder) {
    messages.push(
      createInternalPromptMessage(
        wrapSystemReminder(staleUserReminder),
        "hidden",
        "runtime.stale_user_reminder",
      ),
    );
  }
  if (args.context.shouldInjectDynamicReminder && reminder) {
    messages.push(
      createInternalPromptMessage(
        wrapSystemReminder(reminder),
        "hidden",
        "runtime.orchestrator_reminder",
      ),
    );
  }
  messages.push(
    ...(await buildStartupPromptMessages({
      context: args.context,
      stellaHome: args.stellaHome,
      stellaRoot: args.stellaRoot,
      includeDreamMemoryFiles: true,
    })),
  );
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
}): Promise<void> => {
  await maybeCompactRuntimeThread({
    store: args.store,
    threadKey: args.threadKey,
    resolvedLlm: args.resolvedLlm,
    agentType: args.agentType,
  }).catch((error) => {
    logger.warn("thread.compaction.failed", {
      threadKey: args.threadKey,
      agentType: args.agentType,
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

export const persistAssistantReply = async (args: {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  content: string;
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
