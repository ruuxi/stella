import { isContextOverflow } from "../../ai/utils/overflow.js";
import {
  buildHistorySource,
  persistThreadCustomMessage,
} from "./thread-memory.js";
import { withForcedThreadCompaction } from "./context-budget.js";
import { runCompactionWithHooks } from "./run-completion.js";
import { getThreadTokenEstimate } from "../thread-runtime.js";
import { resetSkillReadDedup } from "../tools/skill-read-dedup.js";

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
  if (preflightRejected) return true;
  const last = agent.state.messages.at(-1);
  if (
    !last ||
    last.role !== "assistant" ||
    (last.stopReason !== "error" && last.stopReason !== "length") ||
    generatedContent(last)
  ) {
    return false;
  }
  const outputTokens = Number(last.usage?.output ?? 0);
  if (Number.isFinite(outputTokens) && outputTokens > 0) return false;
  return isContextOverflow(last, contextWindow);
};

const errorMessage = (error) => {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const executeRecoverableAttempt = async (args, resume = false) => {
  try {
    return await (resume ? args.execute(true) : args.execute());
  } catch (error) {
    if (args.opts.abortSignal?.aborted) throw error;
    const execution = { finalText: "", errorMessage: errorMessage(error) };
    const contextWindow = Number(args.opts.resolvedLlm.model.contextWindow);
    if (!isSafePreGenerationOverflow(execution, args.agent, contextWindow)) {
      throw error;
    }
    return execution;
  }
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
    "Automatic context-overflow recovery could not produce a safe compacted checkpoint; no further provider retry or tool replay was attempted.",
    `thread_id: ${args.threadKey}`,
    `model: ${args.resolvedLlm.model.provider}/${args.resolvedLlm.model.id}`,
    ...(args.reason ? [`reason: ${args.reason}`] : []),
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

const persistRecoverableHandoff = (args) => {
  let text = buildRecoverableHandoff(args);
  try {
    persistThreadCustomMessage(args.store, {
      threadKey: args.threadKey,
      customType: "context-overflow.recovery-handoff",
      content: [{ type: "text", text }],
      display: true,
      eventId: `context-overflow-recovery:${args.runId}`,
    });
  } catch (error) {
    text += `\n\nDurable handoff persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { kind: "handoff", text };
};

export const recoverContextOverflow = async (args) => {
  const contextWindow = Number(args.resolvedLlm.model.contextWindow);
  if (!isSafePreGenerationOverflow(args.execution, args.agent, contextWindow)) {
    return { kind: "not-overflow" };
  }

  const failedAssistant = args.agent.state.messages.at(-1);
  if (
    failedAssistant?.role === "assistant" &&
    (failedAssistant.stopReason === "error" ||
      failedAssistant.stopReason === "length") &&
    !generatedContent(failedAssistant)
  ) {
    args.agent.state.messages.pop();
  }
  while (args.compactionScheduler?.pending(args.threadKey)) {
    await args.compactionScheduler.pending(args.threadKey);
  }
  let threadTokenEstimate;
  try {
    threadTokenEstimate = getThreadTokenEstimate(
      args.store.loadThreadMessages(args.threadKey),
    );
  } catch {
    threadTokenEstimate = undefined;
  }
  const runCompaction = () =>
    withForcedThreadCompaction(args.threadKey, () =>
      runCompactionWithHooks({
        opts: args.opts,
        threadKey: args.threadKey,
        runId: args.runId,
        messageCount: args.agent.state.messages.length,
        ...(threadTokenEstimate !== undefined
          ? { orchestratorTokenEstimate: threadTokenEstimate }
          : {}),
      }),
    );
  const result = await runCompaction();
  if (!result.compacted) {
    return persistRecoverableHandoff(args);
  }
  resetSkillReadDedup(args.threadKey);
  args.session?.notifyCompacted();

  const refreshed = buildHistorySource({
    threadHistory: args.store.loadThreadMessages(args.threadKey),
  });
  const failedTail = refreshed.at(-1);
  if (
    failedTail?.role === "assistant" &&
    (failedTail.stopReason === "error" || failedTail.stopReason === "length") &&
    !generatedContent(failedTail)
  ) {
    refreshed.pop();
  }
  if (refreshed.length === 0 || refreshed.at(-1)?.role === "assistant") {
    return persistRecoverableHandoff(args);
  }
  args.agent.state.messages = refreshed;
  return { kind: "compacted" };
};

export const executeWithContextOverflowRecovery = async (args) => {
  let execution = await executeRecoverableAttempt(args);
  let overflowRecovery;
  try {
    overflowRecovery = await recoverContextOverflow({
      execution,
      agent: args.agent,
      store: args.opts.store,
      threadKey: args.threadKey,
      conversationId: args.opts.conversationId,
      resolvedLlm: args.opts.resolvedLlm,
      compactionScheduler: args.opts.compactionScheduler,
      opts: args.opts,
      runId: args.runId,
      session: args.session,
    });
  } catch (error) {
    overflowRecovery = persistRecoverableHandoff({
      store: args.opts.store,
      threadKey: args.threadKey,
      conversationId: args.opts.conversationId,
      resolvedLlm: args.opts.resolvedLlm,
      runId: args.runId,
      reason: `forced compaction failed: ${errorMessage(error)}`,
    });
  }

  if (overflowRecovery.kind === "handoff") {
    return { finalText: overflowRecovery.text };
  }
  if (overflowRecovery.kind !== "compacted") return execution;

  args.opts.callbacks?.onStatus?.(
    args.runEvents.recordStatus(
      "Context compacted before overflow; retrying once",
      "compacting",
    ),
  );
  execution = await executeRecoverableAttempt(args, true);
  const contextWindow = Number(args.opts.resolvedLlm.model.contextWindow);
  if (isSafePreGenerationOverflow(execution, args.agent, contextWindow)) {
    const handoff = persistRecoverableHandoff({
      store: args.opts.store,
      threadKey: args.threadKey,
      conversationId: args.opts.conversationId,
      resolvedLlm: args.opts.resolvedLlm,
      runId: args.runId,
      reason:
        "the compacted retry grew beyond the model's safe input budget again",
    });
    return { finalText: handoff.text };
  }
  return execution;
};
