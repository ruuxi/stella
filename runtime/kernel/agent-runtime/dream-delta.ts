/**
 * Orchestrator-delta input for Dream (design review §6.1 / migration step 6).
 *
 * Builds the "orchestrator-thread delta" — everything the user actually saw
 * since a persisted message-timestamp watermark: user turns, the
 * orchestrator's authored replies, and the task_lifecycle / task_update
 * completion reports interleaved in order. This is the same watermark
 * mechanism memory-review proved out (`sliceMessagesSinceReview`): because
 * the watermark is a message timestamp, the slice stays correct across
 * worker restarts, and because it reads the RAW persisted thread path
 * (compaction overlays never applied), it is compaction-proof — a checkpoint
 * summary can never masquerade as fresh user signal and a compacted-away
 * span is still readable.
 *
 * Two consumers, staged per the migration plan:
 *   - Shadow validation (this release's default): the delta is derived into a
 *     proposal written ONLY to `memories/memory_shadow.md` and compared
 *     against what the live inbox-driven pass did, so the new input path is
 *     observable before it owns anything.
 *   - Cutover (`dream.inputSource: "delta"`): the delta becomes the Dream
 *     pass's primary input; the inbox keeps only Chronicle transport.
 */

import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import { redactMemoryText } from "../memory/redaction.js";
import { parseThreadCheckpoint } from "../thread-runtime.js";

/**
 * Total transcript budget per pass. When the delta is larger, the transcript
 * keeps the OLDEST messages and the watermark advances only through the last
 * included one — loss-free chunking: the remainder is picked up by the next
 * pass instead of being skipped past.
 */
export const DREAM_DELTA_MAX_CHARS = 60_000;
/** Per-message cap; a giant task report must not eat the whole budget. */
export const DREAM_DELTA_MESSAGE_MAX_CHARS = 4_000;
/**
 * How many raw persisted messages to project when building the delta. The
 * orchestrator thread is eternal; the delta only ever needs the recent tail.
 */
export const DREAM_DELTA_LOAD_LIMIT = 2_000;

/**
 * Custom-message types that enter model context on the orchestrator thread
 * (see EXTERNAL_DELTA_CUSTOM_TYPES in external-engines.ts): managed-child
 * terminal reports and interim task updates. Everything else
 * (display-only lifecycle rows, labels, …) is invisible to the model and
 * therefore not part of the delta.
 */
const DELTA_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "runtime.task_lifecycle",
  "runtime.task_update",
]);

/** Structural shape of one raw persisted thread message (session-store's
 * `loadRawThreadMessagesWithEntryTypes` projection). */
export type DreamDeltaSourceMessage = {
  timestamp: number;
  role: RuntimeThreadMessage["role"];
  content: string;
  payload?: PersistedRuntimeThreadPayload;
  customMessage?: {
    customType: string;
    content: unknown;
    display: boolean;
    eventId?: string;
  };
};

export type DreamDeltaTranscript = {
  transcript: string;
  /** Messages that made it into the transcript. */
  includedMessages: number;
  /**
   * Timestamp of the newest message INCLUDED in the transcript — the value
   * the delta watermark may advance to after a clean pass. 0 when nothing
   * was included.
   */
  coveredThroughTs: number;
  /** Newest delta-relevant message overall (included or not); 0 when none. */
  newestMessageTs: number;
  /** True when the char budget cut the delta short of the newest message. */
  truncated: boolean;
};

const textFromParts = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as { type?: string; text?: string; mimeType?: string };
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[Image: ${block.mimeType ?? "image"}]`;
      return "";
    })
    .join("\n")
    .trim();
};

const assistantAuthoredText = (
  payload: Extract<PersistedRuntimeThreadPayload, { role: "assistant" }>,
): string =>
  payload.content
    .flatMap((block) =>
      block.type === "text" && block.text.trim() ? [block.text] : [],
    )
    .join("\n\n")
    .trim();

/**
 * One delta entry ("[User]\n…"), or null when the message is not part of the
 * delta: tool results, thinking, display-only custom messages, and compaction
 * checkpoints are all excluded. Redaction happens here so nothing upstream
 * has to remember it.
 */
export const formatDeltaEntry = (
  msg: DreamDeltaSourceMessage,
): string | null => {
  if (msg.role === "user") {
    const text =
      msg.payload && msg.payload.role === "user"
        ? textFromParts(msg.payload.content)
        : msg.content;
    const redacted = redactMemoryText(text.trim());
    return redacted ? `[User]\n${redacted}` : null;
  }
  if (msg.role === "assistant") {
    const text =
      msg.payload && msg.payload.role === "assistant"
        ? assistantAuthoredText(msg.payload)
        : msg.content;
    const trimmed = text.trim();
    // Belt and braces: the raw projection carries no compaction overlay
    // entries, but a checkpoint that was ever persisted as a plain assistant
    // message must still never read as fresh signal.
    if (!trimmed || parseThreadCheckpoint(trimmed) !== null) return null;
    const redacted = redactMemoryText(trimmed);
    return redacted ? `[Assistant]\n${redacted}` : null;
  }
  if (msg.customMessage && DELTA_CUSTOM_TYPES.has(msg.customMessage.customType)) {
    const text = textFromParts(msg.customMessage.content) || msg.content;
    const redacted = redactMemoryText(text.trim());
    if (!redacted) return null;
    const label =
      msg.customMessage.customType === "runtime.task_update"
        ? "[Task update]"
        : "[Task report]";
    return `${label}\n${redacted}`;
  }
  return null;
};

const capEntry = (entry: string, maxChars: number): string =>
  entry.length > maxChars ? `${entry.slice(0, maxChars)}\n…[truncated]` : entry;

/**
 * Build the delta transcript from raw persisted messages, oldest first,
 * strictly newer than `sinceMessageTs`. Stops adding once the char budget is
 * reached; `coveredThroughTs` then reflects only what was actually included
 * so the watermark never advances past unread material.
 *
 * Equal-timestamp safety: the watermark filter is a strict `>`, so when the
 * budget cuts between two messages sharing one millisecond, coverage is
 * rolled back BELOW the earliest excluded timestamp — otherwise the excluded
 * tie would be skipped forever. Included ties above the rollback point are
 * simply re-read next pass (idempotent duplication, never loss).
 */
export const buildDreamDeltaTranscript = (
  messages: DreamDeltaSourceMessage[],
  sinceMessageTs: number,
  opts?: { maxChars?: number; messageMaxChars?: number },
): DreamDeltaTranscript => {
  const maxChars = opts?.maxChars ?? DREAM_DELTA_MAX_CHARS;
  const messageMaxChars = opts?.messageMaxChars ?? DREAM_DELTA_MESSAGE_MAX_CHARS;
  const entries: string[] = [];
  let totalChars = 0;
  let includedMessages = 0;
  let coveredThroughTs = 0;
  let newestMessageTs = 0;
  let truncated = false;
  let minExcludedTs = Number.POSITIVE_INFINITY;
  for (const msg of messages) {
    if (!(typeof msg.timestamp === "number" && msg.timestamp > sinceMessageTs)) {
      continue;
    }
    const entry = formatDeltaEntry(msg);
    if (entry === null) continue;
    newestMessageTs = Math.max(newestMessageTs, msg.timestamp);
    const capped = capEntry(entry, messageMaxChars);
    if (
      truncated ||
      (totalChars + capped.length > maxChars && includedMessages > 0)
    ) {
      truncated = true;
      minExcludedTs = Math.min(minExcludedTs, msg.timestamp);
      continue;
    }
    entries.push(capped);
    totalChars += capped.length;
    includedMessages += 1;
    coveredThroughTs = Math.max(coveredThroughTs, msg.timestamp);
  }
  if (truncated && Number.isFinite(minExcludedTs)) {
    // Advance only across a strict timestamp increase: everything at or
    // above the earliest excluded millisecond stays uncovered. (Corner: if
    // this pins coverage at the previous watermark, the pass re-derives the
    // same window — wasteful once, lossy never.)
    coveredThroughTs = Math.min(coveredThroughTs, minExcludedTs - 1);
  }
  return {
    transcript: entries.join("\n\n"),
    includedMessages,
    coveredThroughTs,
    newestMessageTs,
    truncated,
  };
};

/**
 * System prompt for the SHADOW derivation: a one-shot, no-tool completion
 * that produces the consolidation the delta path WOULD apply. Folds the two
 * prompt charters the design review merges into the delta pass: the
 * conversational-continuity gate (memory-review) and the extraction
 * epistemology (Codex survey) — so the shadow validates the real future
 * prompt shape, not a toy.
 */
export const buildDreamShadowSystemPrompt = (): string =>
  [
    "You are the Dream delta-derivation pass for Stella, running in SHADOW mode for a staged migration.",
    "You read the orchestrator conversation delta since the last consolidation watermark and produce the durable-memory consolidation you WOULD apply. You have no tools and write nothing yourself; your entire output is recorded to a shadow log and compared against the live consolidation pass.",
    "",
    "Continuity gate: keep only what the user would be surprised Stella forgot if the live conversation vanished right now. Signal ranking: user messages ≫ task reports ≫ assistant prose. Preserve the user's exact words when recording preferences or decisions. Never memorialize delegated agent internals beyond what a completion report states. Never include secrets, credentials, tokens, or auth headers.",
    "",
    "Output exactly these sections:",
    "## Proposed MEMORY.md blocks",
    "Zero or more blocks in the MEMORY.md schema (## <YYYY-MM-DD HH:MM> — <short title> / Threads / Why this matters / Outcome / Recall hooks), or '- None.'",
    "## Proposed memory_map updates",
    "Routing-entry lines that would be added or updated, or '- None.'",
    "## Derived constraints",
    "Durable constraints not yet in the user profile, one line each tagged [derived YYYY-MM-DD], or '- None.'",
    "",
    "If the delta contains nothing worth consolidating, respond with exactly: Nothing to consolidate.",
  ].join("\n");

export const buildDreamShadowUserPrompt = (args: {
  transcript: string;
  sinceIso: string;
  alreadyKnown?: string;
}): string => {
  const known = args.alreadyKnown?.trim();
  return [
    ...(known
      ? [
          "ALREADY KNOWN (durable memory — do not re-propose anything covered here):",
          known,
          "",
        ]
      : []),
    `ORCHESTRATOR DELTA (messages since ${args.sinceIso}):`,
    "",
    args.transcript,
  ].join("\n");
};

/**
 * User message for the CUTOVER pass (`dream.inputSource: "delta"`): the delta
 * replaces inbox rows as the primary input; the Dream tool still serves the
 * Chronicle transport rows, which are out of the migration's scope.
 */
export const buildDreamDeltaUserMessage = (transcript: string): string =>
  [
    "Run the Dream consolidation pass.",
    "",
    "Primary input — the orchestrator conversation delta since the last consolidation watermark is below. Treat it exactly as you would inbox rows: user turns and task reports are the signal; fold what the user would expect Stella to recall later into MEMORY.md, then update the memory map. Rollout summaries and review notes this delta already carries are excluded from the inbox list, so nothing is double-fed.",
    'Additionally call Dream with action="list": it returns everything the delta does NOT cover — screen-activity (chronicle) digests plus any rollout summaries and review notes from other conversations, manager-run work, or older spans. Fold those exactly like before and markProcessed the ids you handled.',
    "",
    "ORCHESTRATOR DELTA:",
    "",
    transcript,
  ].join("\n");

/** Marker each shadow-log entry starts with; also the trim boundary. */
export const SHADOW_LOG_ENTRY_MARKER = "<!-- DREAM:SHADOW_PASS";
/** On-disk budget for the shadow log; oldest entries are dropped first. */
export const SHADOW_LOG_MAX_CHARS = 262_144;

const SHADOW_LOG_HEADER = `<!-- memory_shadow.md — Dream delta-derivation shadow log (migration step 6).
Written ONLY by the shadow pass; never injected, never read by Recall, never
edited by Dream. Each entry records what the orchestrator-delta input path
WOULD have consolidated, alongside what the live inbox-driven pass actually
changed, so the two derivations can be diffed before cutover. -->
`;

/**
 * One shadow-log entry: the comparison header carries everything needed to
 * diff the two paths without other logs — the delta window, its size, and
 * whether the live pass touched MEMORY.md / the map on the same material.
 */
export const formatShadowLogEntry = (args: {
  nowIso: string;
  conversationId: string;
  sinceTs: number;
  coveredThroughTs: number;
  includedMessages: number;
  transcriptChars: number;
  truncated: boolean;
  liveMemoryChanged: boolean;
  liveMapChanged: boolean;
  proposal: string;
}): string =>
  [
    `${SHADOW_LOG_ENTRY_MARKER} ${args.nowIso} -->`,
    `## Shadow pass ${args.nowIso}`,
    `- conversation: ${args.conversationId}`,
    `- delta window: ${new Date(args.sinceTs).toISOString()} → ${new Date(
      args.coveredThroughTs,
    ).toISOString()} (${args.includedMessages} messages, ${
      args.transcriptChars
    } chars${args.truncated ? ", truncated — remainder next pass" : ""})`,
    `- live inbox pass on the same window: MEMORY.md ${
      args.liveMemoryChanged ? "changed" : "unchanged"
    }, memory_map.md ${args.liveMapChanged ? "changed" : "unchanged"}`,
    "",
    redactMemoryText(args.proposal.trim()),
    "",
  ].join("\n");

/**
 * Append an entry to the shadow log, dropping the OLDEST entries once the
 * file exceeds its budget. The header comment is always preserved.
 */
export const appendToShadowLog = (existing: string | null, entry: string): string => {
  const base = existing?.startsWith(SHADOW_LOG_HEADER.slice(0, 20))
    ? existing
    : SHADOW_LOG_HEADER + (existing ?? "");
  let combined = `${base.trimEnd()}\n\n${entry}`;
  while (combined.length > SHADOW_LOG_MAX_CHARS) {
    const first = combined.indexOf(SHADOW_LOG_ENTRY_MARKER);
    const second =
      first === -1
        ? -1
        : combined.indexOf(SHADOW_LOG_ENTRY_MARKER, first + SHADOW_LOG_ENTRY_MARKER.length);
    if (second === -1) {
      // A single over-budget entry: keep the header and the newest tail.
      const headerEnd = combined.startsWith(SHADOW_LOG_HEADER)
        ? SHADOW_LOG_HEADER.length
        : 0;
      const budget = Math.max(1_024, SHADOW_LOG_MAX_CHARS - headerEnd);
      return (
        combined.slice(0, headerEnd) + combined.slice(combined.length - budget)
      );
    }
    combined = `${combined.slice(0, first)}${combined.slice(second)}`;
  }
  return combined;
};
