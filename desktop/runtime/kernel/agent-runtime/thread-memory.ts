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
import { estimateRuntimeTokens } from "../runtime-threads.js";
import type { PersistedRuntimeThreadPayload } from "../storage/shared.js";
import type { LocalTaskManagerAgentContext } from "../tasks/local-task-manager.js";
import { createRuntimeLogger } from "../debug.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { wrapSystemReminder } from "../message-timestamp.js";
import { now } from "./shared.js";
import { sanitizeAssistantText } from "../internal-tool-transcript.js";

const logger = createRuntimeLogger("agent-runtime.thread-memory");

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

export const buildHistorySource = (
  context: LocalTaskManagerAgentContext,
): Message[] =>
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
        const sanitized = sanitizeAssistantText(entry.content);
        if (!sanitized) return null;
        return createHistoryAssistantMessage([
          { type: "text", text: sanitized } satisfies TextContent,
        ]);
      }
      return null;
    })
    .filter((entry): entry is Message => entry !== null) ?? [];

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
    const sanitizedContent: (TextContent | ThinkingContent | ToolCall)[] = [];
    for (const block of payload.content) {
      if (block.type !== "text") {
        sanitizedContent.push(block);
        continue;
      }
      const sanitized = sanitizeAssistantText(block.text);
      if (sanitized) {
        sanitizedContent.push({ ...block, text: sanitized });
      }
    }
    return {
      ...payload,
      content: sanitizedContent,
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
          const sanitized = sanitizeAssistantText(block.text);
          return sanitized ? [sanitized] : [];
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

  if (context.coreMemory?.trim()) {
    sections.push(`Core memory:\n${context.coreMemory.trim()}`);
  }

  const platformShellPrompt = getPlatformShellPrompt();
  if (platformShellPrompt && hasShellToolGuidance(context)) {
    sections.push(platformShellPrompt);
  }

  return sections.filter(Boolean).join("\n\n");
};

export const buildSelfModDocumentationPrompt = (
  frontendRoot?: string,
): string => {
  if (!frontendRoot?.trim()) return "";

  return [
    "Documentation:",
    "- If you are working on renderer structure, file placement, or ownership boundaries, read `src/STELLA.md` first.",
  ].join("\n");
};

export type OrchestratorPromptMessage = {
  text: string;
  uiVisibility?: "visible" | "hidden";
};

export const buildOrchestratorPromptMessages = (
  context: LocalTaskManagerAgentContext,
  userPrompt: string,
  promptMessages?: OrchestratorPromptMessage[],
): OrchestratorPromptMessage[] => {
  const trimmedUserPrompt = userPrompt.trim();
  const staleUserReminder = context.staleUserReminderText?.trim();
  const reminder = context.orchestratorReminderText?.trim();
  const messages: OrchestratorPromptMessage[] = [];
  if (staleUserReminder) {
    messages.push({
      text: wrapSystemReminder(staleUserReminder),
      uiVisibility: "hidden",
    });
  }
  if (context.shouldInjectDynamicReminder && reminder) {
    messages.push({
      text: wrapSystemReminder(reminder),
      uiVisibility: "hidden",
    });
  }
  if (promptMessages?.length) {
    messages.push(...promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: userPrompt });
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
    return;
  }
  const outputTokens = estimateRuntimeTokens(args.finalText);
  if (outputTokens > 0) {
    updateCounter.call(store, {
      conversationId: args.conversationId,
      incrementBy: outputTokens,
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
