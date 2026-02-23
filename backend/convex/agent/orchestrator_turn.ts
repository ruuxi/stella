import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  computeAutoCompactionThresholdTokens,
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
} from "./context_budget";
import {
  eventsToHistoryMessages,
  type HistoryBuildOptions,
  type HistoryMessage,
  type MicrocompactTrigger,
} from "./history_messages";
import type { PromptBuildResult } from "./prompt_builder";
import { buildSystemPrompt } from "./prompt_builder";
import {
  buildOrchestratorPromptContext,
  type PromptSummaryPair,
} from "./orchestrator_prompt_context";
import { afterChat } from "./hooks";

type UsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type OrchestratorImageAttachment = {
  url: string;
  mimeType?: string;
};

type ChatUserPayload = {
  kind: "chat";
  text: string;
  images?: OrchestratorImageAttachment[];
  platformGuidance?: string;
};

type TaskDeliveryPayload = {
  kind: "task_delivery";
  text: string;
  extraReminderText?: string;
};

export type OrchestratorUserPayload = ChatUserPayload | TaskDeliveryPayload;

type HistoryBuildConfig = {
  enabled?: boolean;
  maxTokens?: number;
  beforeTimestamp?: number;
  excludeEventId?: Id<"events">;
  includeOperationalEvents?: boolean;
  microcompact?: {
    enabled?: boolean;
    trigger?: MicrocompactTrigger;
    modelForWarningThreshold?: unknown;
  };
};

export type PrepareOrchestratorTurnArgs = {
  conversation: Doc<"conversations">;
  conversationId: Id<"conversations">;
  ownerId: string;
  activeThreadId?: Id<"threads"> | null;
  userPayload: OrchestratorUserPayload;
  history?: HistoryBuildConfig;
};

type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      image: URL;
      mediaType?: string;
    };

type OrchestratorModelMessage = {
  role: "user" | "assistant";
  content: string | ChatContentPart[];
};

type ReminderState = {
  shouldInjectDynamicReminder: boolean;
  reminderHash: string;
};

export type PreparedOrchestratorTurn = {
  promptBuild: PromptBuildResult;
  activeThreadId: Id<"threads"> | null;
  summaryPair: PromptSummaryPair;
  historyMessages: HistoryMessage[];
  messages: OrchestratorModelMessage[];
  threadUserMessage: string;
  reminderState: ReminderState;
};

const toUsageSummary = (usage: unknown): UsageSummary | undefined => {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const candidate = usage as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    totalTokens?: unknown;
  };
  const inputTokens =
    typeof candidate.inputTokens === "number" ? candidate.inputTokens : undefined;
  const outputTokens =
    typeof candidate.outputTokens === "number" ? candidate.outputTokens : undefined;
  const totalTokens =
    typeof candidate.totalTokens === "number" ? candidate.totalTokens : undefined;
  if (
    typeof inputTokens !== "number" &&
    typeof outputTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
};

const buildChatContentParts = (args: {
  text: string;
  images?: OrchestratorImageAttachment[];
  reminderText: string;
  shouldInjectReminder: boolean;
}): ChatContentPart[] => {
  const contentParts: ChatContentPart[] = [];
  const trimmedText = args.text.trim();
  if (trimmedText.length > 0) {
    contentParts.push({ type: "text", text: trimmedText });
  }
  for (const image of args.images ?? []) {
    try {
      contentParts.push({
        type: "image",
        image: new URL(image.url),
        mediaType: image.mimeType,
      });
    } catch {
      // Ignore invalid attachment URLs.
    }
  }
  if (contentParts.length === 0) {
    contentParts.push({ type: "text", text: " " });
  }
  if (args.shouldInjectReminder && args.reminderText.length > 0) {
    contentParts.push({
      type: "text",
      text: `\n\n<system-context>\n${args.reminderText}\n</system-context>`,
    });
  }
  return contentParts;
};

const buildHistoryMessages = async (
  ctx: ActionCtx,
  args: {
    conversationId: Id<"conversations">;
    history?: HistoryBuildConfig;
  },
): Promise<HistoryMessage[]> => {
  if (!args.history?.enabled) {
    return [];
  }

  const historyEvents = await ctx.runQuery(internal.events.listRecentContextEventsByTokens, {
    conversationId: args.conversationId,
    maxTokens: args.history.maxTokens,
    beforeTimestamp: args.history.beforeTimestamp,
    excludeEventId: args.history.excludeEventId,
    includeOperationalEvents: args.history.includeOperationalEvents,
    contextAgentType: "orchestrator",
  });

  const microcompactConfig = args.history.microcompact;
  const historyBuildOptions: HistoryBuildOptions =
    microcompactConfig?.enabled === false
      ? {}
      : {
          microcompact: {
            trigger: microcompactConfig?.trigger ?? "auto",
            warningThresholdTokens: computeAutoCompactionThresholdTokens(
              microcompactConfig?.modelForWarningThreshold,
            ),
          },
        };

  const historyBuild = eventsToHistoryMessages(historyEvents, historyBuildOptions);
  if (historyBuild.microcompactBoundary) {
    try {
      await ctx.runMutation(internal.events.appendInternalEvent, {
        conversationId: args.conversationId,
        type: "microcompact_boundary",
        payload: {
          ...historyBuild.microcompactBoundary,
          agentType: "orchestrator",
        },
      });
    } catch {
      // Best effort bookkeeping: never block model execution.
    }
  }
  return historyBuild.messages;
};

export const prepareOrchestratorTurn = async (
  ctx: ActionCtx,
  args: PrepareOrchestratorTurnArgs,
): Promise<PreparedOrchestratorTurn> => {
  const promptBuild = await buildSystemPrompt(ctx, "orchestrator", {
    ownerId: args.ownerId,
    conversationId: args.conversationId,
  });
  const activeThreadId =
    args.activeThreadId !== undefined
      ? args.activeThreadId
      : await ctx.runQuery(internal.conversations.getActiveThreadId, {
          conversationId: args.conversationId,
        });
  const historyMessages = await buildHistoryMessages(ctx, {
    conversationId: args.conversationId,
    history: args.history,
  });

  const extraReminderText =
    args.userPayload.kind === "chat"
      ? args.userPayload.platformGuidance
      : args.userPayload.extraReminderText;
  const orchestratorContext = await buildOrchestratorPromptContext(ctx, {
    conversation: args.conversation,
    activeThreadId,
    dynamicContext: promptBuild.dynamicContext,
    extraReminderText,
  });

  const userContent =
    args.userPayload.kind === "chat"
      ? buildChatContentParts({
          text: args.userPayload.text,
          images: args.userPayload.images,
          reminderText: orchestratorContext.reminderText,
          shouldInjectReminder: orchestratorContext.shouldInjectDynamicReminder,
        })
      : orchestratorContext.shouldInjectDynamicReminder &&
          orchestratorContext.reminderText.length > 0
        ? `${args.userPayload.text}\n\n<system-context>\n${orchestratorContext.reminderText}\n</system-context>`
        : args.userPayload.text;

  return {
    promptBuild,
    activeThreadId,
    summaryPair: orchestratorContext.summaryPair,
    historyMessages,
    messages: [
      ...orchestratorContext.summaryPair,
      ...historyMessages,
      { role: "user", content: userContent },
    ],
    threadUserMessage: args.userPayload.text,
    reminderState: {
      shouldInjectDynamicReminder: orchestratorContext.shouldInjectDynamicReminder,
      reminderHash: orchestratorContext.reminderHash,
    },
  };
};

type ResponseMessageForPersistence = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
};

type FinalizeOrchestratorTurnArgs = {
  conversationId: Id<"conversations">;
  ownerId: string;
  userMessageId?: Id<"events">;
  activeThreadId: Id<"threads"> | null;
  threadUserMessage: string;
  responseMessages?: ResponseMessageForPersistence[];
  assistantText?: string;
  usage?: UsageSummary;
  saveAssistantMessage?: boolean;
  persistThreadFirst?: boolean;
  reminderState: ReminderState;
  scheduleSuggestions?: boolean;
  afterChat?: {
    modelString: string;
    durationMs: number;
    success?: boolean;
  };
};

export const finalizeOrchestratorTurn = async (
  ctx: ActionCtx,
  args: FinalizeOrchestratorTurnArgs,
): Promise<void> => {
  const text = args.assistantText?.trim() ?? "";
  const shouldSaveAssistantMessage = (args.saveAssistantMessage ?? true) && text.length > 0;

  const persistThreadMessages = async () => {
    if (!args.activeThreadId) {
      return;
    }
    const messagesToSave: Array<{
      role: string;
      content: string;
      toolCallId?: string;
      tokenEstimate?: number;
    }> = [{ role: "user", content: args.threadUserMessage }];

    for (const msg of args.responseMessages ?? []) {
      const role = typeof msg.role === "string" ? msg.role : "assistant";
      const rawToolCallId = msg.toolCallId;
      const toolCallId =
        typeof rawToolCallId === "string"
          ? rawToolCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
          : undefined;

      messagesToSave.push({
        role,
        content: JSON.stringify({
          role,
          content: msg.content,
          ...(toolCallId ? { toolCallId } : {}),
        }),
        ...(toolCallId ? { toolCallId } : {}),
      });
    }

    if (messagesToSave.length > 1) {
      await ctx.runMutation(internal.data.threads.saveThreadMessages, {
        threadId: args.activeThreadId,
        messages: messagesToSave,
      });

      const updatedThread = await ctx.runQuery(internal.data.threads.getThreadById, {
        threadId: args.activeThreadId,
      });
      if (
        (updatedThread?.totalTokenEstimate ?? 0) >=
        ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
      ) {
        await ctx.scheduler.runAfter(0, internal.data.threads.compactThread, {
          threadId: args.activeThreadId,
        });
      }
    }
  };

  const persistAssistantMessage = async () => {
    if (!shouldSaveAssistantMessage) {
      return;
    }
    await ctx.runMutation(internal.events.saveAssistantMessage, {
      conversationId: args.conversationId,
      text,
      userMessageId: args.userMessageId,
      usage: args.usage,
    });
  };

  if (args.persistThreadFirst) {
    await persistThreadMessages();
    await persistAssistantMessage();
  } else {
    await persistAssistantMessage();
    await persistThreadMessages();
  }

  if (
    args.reminderState.shouldInjectDynamicReminder &&
    args.reminderState.reminderHash &&
    args.activeThreadId
  ) {
    await ctx.runMutation(internal.conversations.markOrchestratorReminderSeen, {
      conversationId: args.conversationId,
      threadId: args.activeThreadId,
      reminderHash: args.reminderState.reminderHash,
    });
  }

  if (args.afterChat) {
    await afterChat(ctx, {
      ownerId: args.ownerId,
      conversationId: args.conversationId,
      agentType: "orchestrator",
      modelString: args.afterChat.modelString,
      usage: args.usage,
      durationMs: args.afterChat.durationMs,
      success: args.afterChat.success ?? true,
    });
  }

  if (shouldSaveAssistantMessage && (args.scheduleSuggestions ?? true)) {
    try {
      await ctx.scheduler.runAfter(0, internal.agent.suggestions.generateSuggestions, {
        conversationId: args.conversationId,
        ownerId: args.ownerId,
      });
    } catch {
      // Best effort.
    }
  }
};

export { toUsageSummary };
