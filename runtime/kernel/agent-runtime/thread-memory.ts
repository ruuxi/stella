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
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadCustomMessageEntry,
} from "../storage/shared.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
import { createRuntimeLogger } from "../debug.js";
import type { RuntimePromptMessage } from "../../protocol/index.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { wrapSystemReminder } from "../message-timestamp.js";
import { now } from "./shared.js";
import type { AgentMessage } from "../agent-core/types.js";

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

// Generic over the message union: works for both Message[] (history we just
// reconstituted from SQLite) and AgentMessage[] (the live agent's running
// state, which may include `runtimeInternal` entries that we leave alone).
// Only `toolResult` messages with image content blocks are ever rewritten.
export const stripStaleImageBlocks = <T extends { role: string }>(
  messages: T[],
): T[] => {
  let imagesKept = 0;
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
    if (imagesKept < KEEP_RECENT_IMAGES_IN_HISTORY) {
      imagesKept += 1;
      out.push(message);
      continue;
    }
    const compactContent = toolResult.content.map((block) => {
      if (block.type !== "image") {
        return block;
      }
      const sizeKb = Math.round(((block.data?.length ?? 0) * 0.75) / 1024);
      return {
        type: "text",
        text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
      };
    });
    rewroteAny = true;
    out.push({
      ...(message as object),
      content: compactContent,
    } as unknown as T);
  }
  // Allocating a new array only matters when we actually rewrote something;
  // keep the input identity stable when no rewrite happened so downstream
  // callers can fast-path on referential equality.
  return rewroteAny ? out.reverse() : messages;
};

export const buildHistorySource = (
  context: LocalAgentContext,
): AgentMessage[] => {
  const memoryBootstrapKeysKept = new Set<string>();
  const memoryBootstrapReplayKey = (entry: AgentMessage): string | null => {
    if (entry.role !== "runtimeInternal") return null;
    if (
      entry.customType !== "bootstrap.memory_file" &&
      entry.customType !== "bootstrap.memory_snapshot"
    ) {
      return null;
    }
    const text = Array.isArray(entry.content)
      ? entry.content
          .flatMap((block) =>
            block.type === "text" ? [block.text] : [],
          )
          .join("\n")
      : "";
    if (entry.customType === "bootstrap.memory_file") {
      const pathMatch = /<memory_file path="([^"]+)">/.exec(text);
      return `memory_file:${pathMatch?.[1] ?? text.slice(0, 80)}`;
    }
    const targetMatch = /<memory_snapshot target="([^"]+)">/.exec(text);
    return `memory_snapshot:${targetMatch?.[1] ?? text.slice(0, 80)}`;
  };
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
        if (entry.role === "runtimeInternal" && typeof entry.content === "string") {
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
      .filter((entry): entry is AgentMessage => entry !== null)
      .reverse()
      .filter((entry) => {
        const key = memoryBootstrapReplayKey(entry);
        if (!key) return true;
        if (memoryBootstrapKeysKept.has(key)) return false;
        memoryBootstrapKeysKept.add(key);
        return true;
      })
      .reverse() ?? [];
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

export const persistThreadCustomMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    customType: string;
    content: RuntimeThreadCustomMessageEntry["content"];
    display?: boolean;
    timestamp?: number;
  },
): void => {
  store.appendThreadCustomMessage({
    threadKey: args.threadKey,
    timestamp: args.timestamp ?? now(),
    customType: args.customType,
    content: args.content,
    display: args.display === true,
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

const hasShellToolGuidance = (
  context: LocalAgentContext,
): boolean => {
  return hasToolGuidance(context, ["Bash", "exec_command"]);
};

const buildFileEditingPrompt = (
  context: LocalAgentContext,
): string | null => {
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

export const buildSystemPrompt = (
  context: LocalAgentContext,
): string => {
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

/**
 * Cadence for re-injecting the dynamic memory bundle (memory_summary.md +
 * MEMORY.md + MEMORY/USER snapshots) into the Orchestrator prompt. The
 * runtime persists the injected bundle as hidden transcript messages; turns
 * between injections replay that stored bundle without rebuilding it. Inject
 * on turn 1, then every Nth turn after (turns 41, 81, ...).
 */
export const MEMORY_INJECTION_TURN_THRESHOLD = 40;

const injectDreamMemoryFiles = async (args: {
  messages: RuntimePromptMessage[];
  stellaHome?: string;
  stellaRoot?: string;
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
  context: LocalAgentContext;
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

  // Dream-managed memory files (memory_summary.md, MEMORY.md) and the
  // frozen MEMORY/USER snapshots are the "dynamic memory bundle" — only
  // re-injected on Orchestrator turns the runner marked with
  // shouldInjectDynamicMemory (cold start + every Nth user turn). The runtime
  // persists those hidden bootstrap messages so fresh agent sessions can
  // replay the latest bundle on coast turns without rebuilding it every time.
  if (args.includeDreamMemoryFiles && args.context.shouldInjectDynamicMemory) {
    await injectDreamMemoryFiles({
      messages,
      stellaHome: args.stellaHome,
      stellaRoot: args.stellaRoot,
    });

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
  }

  return messages;
};

export const buildSubagentPromptMessages = async (args: {
  context: LocalAgentContext;
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
  context: LocalAgentContext;
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
