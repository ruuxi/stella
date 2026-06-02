/**
 * Background Orchestrator memory review.
 *
 * Fires after the Orchestrator finalizes a successful turn whenever the
 * memory-review user-turn counter has reached the threshold (default 20) or a
 * compaction is imminent. The review is a one-shot, fire-and-forget completion
 * that:
 *
 *   1. Sees the recent Orchestrator transcript (windowed to the delta since
 *      the last review), only user and assistant text.
 *   2. Applies a conversational-continuity gate (what the user would expect
 *      Stella to recall later), excluding restated delegated agent work.
 *   3. Writes a small candidate file under memories_extensions for Dream to
 *      consolidate later.
 *
 * Errors are swallowed - this is best-effort; user already has their reply
 * by the time this fires.
 */

import { completeSimple, readAssistantText } from "../../ai/stream.js";
import { parseJsonWithRepair } from "../../ai/utils/json-parse.js";
import type { AssistantMessage, Context, Message } from "../../ai/types.js";
import type { AgentMessage } from "../agent-core/types.js";
import { readMemorySummary } from "../memory/dream-storage.js";
import {
  redactMemoryText,
  redactMemoryStringArray,
} from "../memory/redaction.js";
import {
  readRecentOrchestratorReviewNotes,
  writeOrchestratorReviewMemoryNote,
  type OrchestratorReviewMemoryNote,
} from "../memory/orchestrator-review-notes.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import { parseThreadCheckpoint } from "../thread-runtime.js";
import { createRuntimeLogger } from "../debug.js";
import {
  runClaudeCodeAgentTextCompletion,
  shouldUseClaudeCodeAgentRuntime,
} from "../integrations/claude-code-agent-runtime.js";

const logger = createRuntimeLogger("agent-runtime.memory-review");

export const MEMORY_REVIEW_TURN_THRESHOLD = 20;

const KNOWN_MEMORY_RECENT_NOTE_LIMIT = 8;
const KNOWN_MEMORY_MAX_CHARS = 6_000;

const MEMORY_REVIEW_SYSTEM_PROMPT = [
  "You are Stella's background memory pass for the Orchestrator — the ongoing conversation between the user and Stella. You see only recent user and assistant messages from that conversation.",
  "",
  'Capture what Stella should still know about this conversation after the live context is compacted away, so that later — when the user picks a topic back up or says "the thing we discussed" — Stella still has it.',
  "",
  "Test each candidate: if the live context vanished right now, would the user be surprised Stella forgot this? Save it only if yes.",
  "",
  "Worth saving:",
  "  - What the user is working on, planning, or thinking through — current goals, decisions, and open threads in the conversation.",
  "  - Durable facts the user shares about themselves, their projects, or their situation.",
  "  - Stable preferences and expectations for how Stella should behave.",
  "",
  "Not worth saving:",
  "  - Summaries of work a delegated agent did or produced — that is remembered separately; never restate agent task results here.",
  "  - One-off mechanical requests, transient status, or assistant suggestions the user did not take up.",
  "  - Anything already in # Known Memory, or that only replays the exchange without preserving something the user would want recalled later.",
  "",
  "Output JSON only, with no markdown fences.",
  "",
  "If nothing is worth saving:",
  '{"shouldWrite":false,"reason":"brief reason"}',
  "",
  "If something is worth saving:",
  '{"shouldWrite":true,"title":"short title","category":"user_preference|stella_expectation|active_focus|personal_context","memory":"concise durable memory","recallHooks":["2-8 search hooks"],"evidence":["1-3 short user/assistant snippets, no secrets"]}',
].join("\n");

const MEMORY_REVIEW_USER_PROMPT_PREFIX =
  "Review the recent conversation below and act according to your instructions.\n\n";

export const buildMemoryReviewSystemPrompt = (): string =>
  MEMORY_REVIEW_SYSTEM_PROMPT;

const formatTextContent = (parts: AssistantMessage["content"]): string =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return "";
      return "";
    })
    .join("")
    .trim();

const summarizeMessageForTranscript = (msg: AgentMessage): string | null => {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      const text = redactMemoryText(msg.content.trim());
      return text ? `[User]\n${text}` : null;
    }
    const text = redactMemoryText(
      msg.content
        .map((part) =>
          part.type === "text" ? part.text : `[Image: ${part.mimeType}]`,
        )
        .join("\n")
        .trim(),
    );
    return text ? `[User]\n${text}` : null;
  }
  if (msg.role === "assistant") {
    const text = redactMemoryText(formatTextContent(msg.content));
    return text ? `[Assistant]\n${text}` : null;
  }
  return null;
};

export const buildMemoryReviewTranscript = (messages: AgentMessage[]): string =>
  messages
    .map(summarizeMessageForTranscript)
    .filter((entry): entry is string => entry != null)
    .join("\n\n");

const isCheckpointMessage = (msg: AgentMessage): boolean => {
  if (msg.role !== "assistant") return false;
  const text = formatTextContent(msg.content);
  return text ? parseThreadCheckpoint(text) !== null : false;
};

/**
 * Newest message timestamp in a snapshot, or 0 when none carry one. Used as
 * the review watermark so the next pass only sees messages created after it.
 */
export const maxMessageTimestamp = (messages: AgentMessage[]): number =>
  messages.reduce(
    (max, msg) =>
      typeof msg.timestamp === "number" && msg.timestamp > max
        ? msg.timestamp
        : max,
    0,
  );

/**
 * Slice a snapshot down to the messages a review should actually read:
 * only those newer than the previous review watermark, with compaction
 * checkpoint/summary messages dropped so a post-compaction summary never
 * masquerades as fresh user signal. Because the watermark is a message
 * timestamp (not an array index), this stays correct across compaction
 * rebuilds and worker restarts — no separate "discard on compaction" reset
 * is needed.
 */
export const sliceMessagesSinceReview = (
  messages: AgentMessage[],
  sinceMessageTs: number,
): AgentMessage[] => {
  if (!(sinceMessageTs > 0)) {
    return messages.filter((msg) => !isCheckpointMessage(msg));
  }
  return messages.filter(
    (msg) =>
      typeof msg.timestamp === "number" &&
      msg.timestamp > sinceMessageTs &&
      !isCheckpointMessage(msg),
  );
};

export const buildMemoryReviewUserPrompt = (
  transcript: string,
  knownMemory?: string,
): string => {
  const known = knownMemory?.trim();
  if (!known) {
    return `${MEMORY_REVIEW_USER_PROMPT_PREFIX}${transcript}`;
  }
  return [
    "# Known Memory",
    "Already remembered or recently proposed. Do not propose anything already covered here.",
    "",
    known,
    "",
    `${MEMORY_REVIEW_USER_PROMPT_PREFIX}${transcript}`,
  ].join("\n");
};

/**
 * Compact "already recorded / recently proposed" context so the gate can skip
 * duplicates at the source. Combines Dream's consolidated active-focus view
 * (`memory_summary.md`) with the most recent orchestrator-review candidate
 * notes (which may not be consolidated yet). Best-effort and bounded; returns
 * an empty string when nothing is available.
 */
export const buildKnownMemoryContext = async (
  stellaHome: string,
): Promise<string> => {
  const [summary, recentNotes] = await Promise.all([
    readMemorySummary(stellaHome).catch(() => null),
    readRecentOrchestratorReviewNotes(
      stellaHome,
      KNOWN_MEMORY_RECENT_NOTE_LIMIT,
    ).catch(() => [] as string[]),
  ]);

  const blocks: string[] = [];
  const trimmedSummary = summary ? redactMemoryText(summary.trim()) : "";
  if (trimmedSummary) {
    blocks.push(
      `<consolidated_memory path="~/.stella/memories/memory_summary.md">\n${trimmedSummary}\n</consolidated_memory>`,
    );
  }
  if (recentNotes.length > 0) {
    blocks.push(
      `<recent_candidates>\n${redactMemoryText(
        recentNotes.join("\n\n---\n\n"),
      )}\n</recent_candidates>`,
    );
  }
  if (blocks.length === 0) return "";

  const joined = blocks.join("\n\n");
  return joined.length > KNOWN_MEMORY_MAX_CHARS
    ? `${joined.slice(0, KNOWN_MEMORY_MAX_CHARS)}\n...[truncated]`
    : joined;
};

type MemoryReviewModelOutput = {
  shouldWrite?: unknown;
  reason?: unknown;
  title?: unknown;
  category?: unknown;
  memory?: unknown;
  recallHooks?: unknown;
  evidence?: unknown;
};

const extractJsonObject = (text: string): string => {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
};

const toStringArray = (value: unknown, maxItems: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

export const parseMemoryReviewCandidate = (
  text: string,
): OrchestratorReviewMemoryNote | null => {
  const parsed = parseJsonWithRepair<MemoryReviewModelOutput>(
    extractJsonObject(text),
  );
  if (parsed.shouldWrite !== true) {
    return null;
  }
  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const memory = typeof parsed.memory === "string" ? parsed.memory.trim() : "";
  if (!title || !memory) {
    return null;
  }
  const category =
    typeof parsed.category === "string" && parsed.category.trim()
      ? parsed.category.trim()
      : "active_focus";
  return {
    title: redactMemoryText(title),
    category: redactMemoryText(category),
    memory: redactMemoryText(memory),
    recallHooks: redactMemoryStringArray(toStringArray(parsed.recallHooks, 8)),
    evidence: redactMemoryStringArray(toStringArray(parsed.evidence, 3)),
  };
};

const runReview = async (args: {
  conversationId: string;
  stellaHome: string;
  stellaRoot: string;
  messagesSnapshot: AgentMessage[];
  /** Only messages newer than this watermark are reviewed (0 = review all). */
  sinceMessageTs: number;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
  /**
   * Resolves `true` when the review reached a clean terminal state (ran and
   * parsed, even with no candidate, or had nothing new to review) so the
   * caller may safely advance the watermark; `false` when a transient failure
   * (no api key, LLM outage, parse/write error) means those messages should be
   * reviewed again on a later pass.
   */
}): Promise<boolean> => {
  const useClaudeCode = shouldUseClaudeCodeAgentRuntime({
    stellaRoot: args.stellaRoot,
    modelId: args.resolvedLlm.model.id,
  });
  const apiKey = useClaudeCode
    ? undefined
    : (await args.resolvedLlm.getApiKey())?.trim();
  if (!useClaudeCode && !apiKey) {
    logger.debug("memory-review.skipped.no-api-key");
    return false;
  }

  const windowedMessages = sliceMessagesSinceReview(
    args.messagesSnapshot,
    args.sinceMessageTs,
  );
  const transcript = buildMemoryReviewTranscript(windowedMessages);
  if (!transcript) {
    logger.debug("memory-review.skipped.empty-transcript", {
      sinceMessageTs: args.sinceMessageTs,
    });
    return true;
  }

  const knownMemory = await buildKnownMemoryContext(args.stellaHome).catch(
    () => "",
  );
  const reviewSystemPrompt = buildMemoryReviewSystemPrompt();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildMemoryReviewUserPrompt(transcript, knownMemory),
        },
      ],
      timestamp: Date.now(),
    },
  ];

  let finalText = "";
  if (useClaudeCode) {
    try {
      finalText = await runClaudeCodeAgentTextCompletion({
        stellaRoot: args.stellaRoot,
        agentType: "memory_review",
        stellaModel: args.resolvedLlm.model.id,
        context: {
          systemPrompt: reviewSystemPrompt,
          messages,
          tools: [],
        },
      });
    } catch (error) {
      logger.debug("memory-review.claude-code.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  } else {
    const context: Context = {
      systemPrompt: reviewSystemPrompt,
      messages,
      tools: [],
    };

    let response: AssistantMessage;
    try {
      response = await completeSimple(args.resolvedLlm.model, context, {
        apiKey,
      });
    } catch (error) {
      logger.debug("memory-review.completeSimple.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    finalText = readAssistantText(response);
  }

  let candidate: OrchestratorReviewMemoryNote | null = null;
  try {
    candidate = parseMemoryReviewCandidate(finalText);
  } catch (error) {
    logger.debug("memory-review.parse-failed", {
      error: error instanceof Error ? error.message : String(error),
      finalText: finalText.slice(0, 160),
    });
    return false;
  }

  if (!candidate) {
    logger.debug("memory-review.completed.no-candidate", {
      finalText: finalText.slice(0, 80),
    });
    return true;
  }

  try {
    const written = await writeOrchestratorReviewMemoryNote({
      stellaHome: args.stellaHome,
      note: candidate,
    });
    logger.debug("memory-review.completed.candidate-written", {
      path: written.path,
      title: candidate.title,
    });
    // The candidate persists as a durable extension file; Dream folds it on its
    // next token-interval or pre-compaction run. We deliberately do not ping
    // Dream here — consolidation cadence is driven by orchestrator context
    // growth, not by each candidate write.
    return true;
  } catch (error) {
    logger.debug("memory-review.write-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/**
 * Fire-and-forget background memory review. Never throws; never blocks the
 * caller. Resets the user-turn counter immediately so a fast follow-up turn
 * does not double-trigger, but advances the review watermark only after the
 * review actually completes — a transient failure (provider outage, parse
 * error) must not permanently exclude those messages from a future pass.
 *
 * `sinceMessageTs` is the previous watermark (read by the caller before this
 * fires); `runReview` slices the snapshot to messages newer than it.
 */
export const spawnMemoryReview = (args: {
  conversationId: string;
  stellaHome: string;
  stellaRoot: string;
  messagesSnapshot: AgentMessage[];
  sinceMessageTs: number;
  resolvedLlm: ResolvedLlmRoute;
  store: RuntimeStore;
}): void => {
  try {
    // Reset the counter (preserve the watermark) so a fast follow-up turn does
    // not re-trigger while this review is in flight.
    args.store.resetUserTurnsSinceMemoryReview(args.conversationId);
  } catch {
    // counter reset is best-effort
  }
  void runReview(args)
    .then((reviewed) => {
      if (!reviewed) return;
      const reviewedThroughTs = maxMessageTimestamp(args.messagesSnapshot);
      if (reviewedThroughTs <= 0) return;
      try {
        args.store.advanceMemoryReviewWatermark(
          args.conversationId,
          reviewedThroughTs,
        );
      } catch {
        // watermark advance is best-effort
      }
    })
    .catch((error) => {
      logger.debug("memory-review.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
