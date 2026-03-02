/**
 * Local Thread Compaction
 *
 * Loads thread messages from Convex, computes the compaction cut point,
 * formats messages, calls the LLM proxy for a summary, then applies
 * the compaction via a Convex mutation.
 */

import { generateText, type LanguageModel } from "ai";
import {
  THREAD_COMPACTION_KEEP_RECENT_TOKENS,
  ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS,
  SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS,
  MIN_MESSAGES_FOR_COMPACTION,
  THREAD_COMPACTION_MAX_RETRIES,
  THREAD_COMPACTION_PROMPT,
  THREAD_COMPACTION_UPDATE_PROMPT,
  TURN_PREFIX_SUMMARY_PROMPT,
  formatThreadMessagesForCompaction,
  findThreadCompactionCutByTokens,
} from "@stella/shared";

type ThreadData = {
  thread: {
    _id: string;
    name: string;
    status: string;
    summary?: string;
    totalTokenEstimate: number;
    messageCount: number;
  };
  messages: Array<{
    role: string;
    content: string;
    ordinal: number;
    tokenEstimate?: number;
  }>;
};

export type CompactThreadLocallyOpts = {
  model: LanguageModel;
  threadId: string;
  agentType: string;
  fetchThreadData: () => Promise<ThreadData | null>;
  applyCompaction: (args: {
    threadId: string;
    keepFromOrdinal: number;
    summary: string;
  }) => Promise<void>;
};

async function generateWithRetry(
  model: LanguageModel,
  promptBody: string,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= THREAD_COMPACTION_MAX_RETRIES; attempt += 1) {
    try {
      const result = await generateText({
        model,
        system: "Output ONLY the summary content.",
        messages: [{ role: "user", content: promptBody }],
        maxTokens: 12096,
      });
      const text = result.text.trim();
      if (text.length > 0) return text;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Thread compaction summary generation failed");
}

export async function compactThreadLocally(
  opts: CompactThreadLocallyOpts,
): Promise<void> {
  // 1. Load thread data
  const data = await opts.fetchThreadData();
  if (!data) return;

  const { thread, messages } = data;
  if (thread.status !== "active") return;

  // 2. Check threshold
  const triggerTokens = thread.name === "Main"
    ? ORCHESTRATOR_THREAD_COMPACTION_TRIGGER_TOKENS
    : SUBAGENT_THREAD_COMPACTION_TRIGGER_TOKENS;
  if (thread.totalTokenEstimate < triggerTokens) return;

  // 3. Skip if too few messages
  if (messages.length <= MIN_MESSAGES_FOR_COMPACTION) return;

  // 4. Compute cut point
  const cut = findThreadCompactionCutByTokens(messages, THREAD_COMPACTION_KEEP_RECENT_TOKENS);
  const oldMessages = messages.slice(0, cut.historyEndIndex);
  const turnPrefixMessages = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.recentStartIndex)
    : [];
  const recentMessages = messages.slice(cut.recentStartIndex);

  if (oldMessages.length === 0 && turnPrefixMessages.length === 0) return;

  // 5. Format old messages
  const oldText = formatThreadMessagesForCompaction(
    oldMessages.map((m) => ({ role: m.role, content: m.content })),
  );

  // 6. Generate summary via LLM
  const hasPreviousSummary = Boolean(thread.summary && thread.summary.trim().length > 0);

  let baseSummary = hasPreviousSummary ? thread.summary!.trim() : "";
  if (oldText.trim().length > 0) {
    const promptBody = [
      `<conversation>\n${oldText}\n</conversation>`,
      hasPreviousSummary ? `<previous-summary>\n${thread.summary!.trim()}\n</previous-summary>` : "",
      hasPreviousSummary ? THREAD_COMPACTION_UPDATE_PROMPT : THREAD_COMPACTION_PROMPT,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    baseSummary = await generateWithRetry(opts.model, promptBody);
  }

  let turnPrefixSummary = "";
  if (turnPrefixMessages.length > 0) {
    const turnPrefixText = formatThreadMessagesForCompaction(
      turnPrefixMessages.map((m) => ({ role: m.role, content: m.content })),
    );
    if (turnPrefixText.trim().length > 0) {
      turnPrefixSummary = await generateWithRetry(
        opts.model,
        `<conversation>\n${turnPrefixText}\n</conversation>\n\n${TURN_PREFIX_SUMMARY_PROMPT}`,
      );
    }
  }

  const summary = [baseSummary, turnPrefixSummary ? `---\n\n${turnPrefixSummary}` : ""]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  if (summary.length === 0) return;

  // 7. Apply compaction via Convex mutation
  const firstRecentOrdinal = recentMessages[0]?.ordinal ?? 0;
  await opts.applyCompaction({
    threadId: opts.threadId,
    keepFromOrdinal: firstRecentOrdinal,
    summary,
  });
}
