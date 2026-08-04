import { isContextOverflow } from "../../ai/utils/overflow.js";
import {
  buildHistorySource,
  compactRuntimeThreadHistory,
} from "./thread-memory.js";
import { withForcedThreadCompaction } from "./context-budget.js";

const generatedContent = (message) =>
  message.content?.some((block) => {
    if (block.type === "toolCall") return true;
    if (block.type === "text") return Boolean(block.text?.trim());
    if (block.type === "thinking") return Boolean(block.thinking?.trim());
    return true;
  }) ?? false;

const isSafePreGenerationOverflow = (execution, agent, contextWindow) => {
  if (!execution?.errorMessage) return false;
  const preflightRejected = execution.errorMessage.includes(
    "Context preflight context_length_exceeded before provider dispatch",
  );
  const last = agent.state.messages.at(-1);
  if (preflightRejected && last?.role !== "assistant") return true;
  if (
    !last ||
    last.role !== "assistant" ||
    last.stopReason !== "error" ||
    generatedContent(last)
  ) {
    return false;
  }
  const outputTokens = Number(last.usage?.output ?? 0);
  if (Number.isFinite(outputTokens) && outputTokens > 0) return false;
  return isContextOverflow(last, contextWindow);
};

const messageText = (message) => {
  if (message.payload?.role === "user") {
    return typeof message.payload.content === "string"
      ? message.payload.content
      : message.payload.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
  }
  return typeof message.content === "string" ? message.content : "";
};

const truncate = (value, maxChars) => {
  const text = value?.trim() ?? "";
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n[truncated; full record remains durable]`;
};

const buildRecoverableHandoff = (args) => {
  let history = [];
  let children = [];
  try {
    history = args.store.loadThreadMessages(args.threadKey);
  } catch {
    // The identifiers below still provide a usable recovery anchor.
  }
  try {
    children = args.store
      .listThreadActivity(args.conversationId)
      .filter((entry) => entry.parentAgentId === args.threadKey);
  } catch {
    // Child details are best-effort; their rows remain durable.
  }

  const latestUser = [...history]
    .reverse()
    .find((message) => message.role === "user");
  const checkpoint = [...history]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.startsWith("[[THREAD_CHECKPOINT]]"),
    );
  const childLines = children.map((child) => {
    const detail = truncate(child.result || child.error || "", 600);
    return `- ${child.threadId}: ${child.status}${detail ? ` - ${detail}` : ""}`;
  });

  return [
    "Automatic context-overflow recovery could not produce a safe compacted checkpoint; no provider retry or tool replay was attempted.",
    `thread_id: ${args.threadKey}`,
    `model: ${args.resolvedLlm.model.provider}/${args.resolvedLlm.model.id}`,
    "Recovery: resume in a fresh General thread using the durable thread and child records below as source of truth.",
    "",
    "Latest user instruction:",
    truncate(
      latestUser ? messageText(latestUser) : "Unavailable in projection",
      4_000,
    ),
    "",
    "Durable checkpoint:",
    truncate(
      checkpoint?.content ||
        "No checkpoint was available; inspect the durable thread directly.",
      12_000,
    ),
    "",
    "Direct child threads:",
    ...(childLines.length > 0
      ? childLines
      : ["- Inspect durable Activity records for this parent thread."]),
  ].join("\n");
};

export const recoverContextOverflow = async (args) => {
  const contextWindow = Number(args.resolvedLlm.model.contextWindow);
  if (!isSafePreGenerationOverflow(args.execution, args.agent, contextWindow)) {
    return { kind: "not-overflow" };
  }

  const failedAssistant = args.agent.state.messages.at(-1);
  if (
    failedAssistant?.role === "assistant" &&
    failedAssistant.stopReason === "error" &&
    !generatedContent(failedAssistant)
  ) {
    args.agent.state.messages.pop();
  }
  while (args.compactionScheduler?.pending(args.threadKey)) {
    await args.compactionScheduler.pending(args.threadKey);
  }
  const runCompaction = () =>
    withForcedThreadCompaction(args.threadKey, () =>
      compactRuntimeThreadHistory({
        store: args.store,
        threadKey: args.threadKey,
        resolvedLlm: args.resolvedLlm,
        agentType: args.agentType,
        stellaDataDir: args.stellaDataDir,
      }),
    );
  let result = { compacted: false };
  if (args.compactionScheduler) {
    await args.compactionScheduler.schedule({
      threadKey: args.threadKey,
      run: async () => {
        result = await runCompaction();
      },
    });
  } else {
    result = await runCompaction();
  }
  if (!result.compacted) {
    return { kind: "handoff", text: buildRecoverableHandoff(args) };
  }

  const refreshed = buildHistorySource({
    threadHistory: args.store.loadThreadMessages(args.threadKey),
  });
  const failedTail = refreshed.at(-1);
  if (
    failedTail?.role === "assistant" &&
    failedTail.stopReason === "error" &&
    !generatedContent(failedTail)
  ) {
    refreshed.pop();
  }
  if (refreshed.length === 0 || refreshed.at(-1)?.role === "assistant") {
    return { kind: "handoff", text: buildRecoverableHandoff(args) };
  }
  args.agent.state.messages = refreshed;
  return { kind: "compacted" };
};
