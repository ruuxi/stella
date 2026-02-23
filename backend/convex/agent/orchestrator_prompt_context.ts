import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { hashString } from "../lib/string_hash";

export type PromptSummaryPair = Array<{ role: "user" | "assistant"; content: string }>;

export type OrchestratorPromptContext = {
  summaryPair: PromptSummaryPair;
  reminderText: string;
  reminderHash: string;
  shouldInjectDynamicReminder: boolean;
};

type BuildOrchestratorPromptContextArgs = {
  conversation: Doc<"conversations">;
  activeThreadId: Id<"threads"> | null;
  dynamicContext?: string;
  extraReminderText?: string;
};

export const buildOrchestratorPromptContext = async (
  ctx: ActionCtx,
  args: BuildOrchestratorPromptContextArgs,
): Promise<OrchestratorPromptContext> => {
  let summaryPair: PromptSummaryPair = [];
  if (args.activeThreadId) {
    const thread = await ctx.runQuery(internal.data.threads.getThreadById, {
      threadId: args.activeThreadId,
    });
    if (thread?.summary) {
      summaryPair = [
        {
          role: "user",
          content: `[Thread context - prior work summary]\n${thread.summary}`,
        },
        {
          role: "assistant",
          content: "Understood. I have the context from previous work.",
        },
      ];
    }
  }

  const reminderParts = [
    args.dynamicContext?.trim() ?? "",
    args.extraReminderText?.trim() ?? "",
  ].filter((part) => part.length > 0);
  const reminderText = reminderParts.join("\n\n").trim();
  if (reminderText.length === 0) {
    return {
      summaryPair,
      reminderText: "",
      reminderHash: "",
      shouldInjectDynamicReminder: false,
    };
  }

  const reminderHash = hashString(reminderText);
  const shouldInjectDynamicReminder =
    !args.activeThreadId ||
    args.conversation.orchestratorReminderHash !== reminderHash ||
    args.conversation.orchestratorReminderThreadId !== args.activeThreadId;

  return {
    summaryPair,
    reminderText,
    reminderHash,
    shouldInjectDynamicReminder,
  };
};
