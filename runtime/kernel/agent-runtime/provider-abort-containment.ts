import type { AgentMessage } from "../agent-core/types.js";
import type { Api, Model } from "../../ai/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";

/**
 * Containment for provider content aborts.
 *
 * Diagnosed failure mode: a specific text sequence persisted in a thread's
 * context (e.g. quoted email/web content) triggers a provider-side stream
 * abort (refusal/safety/content-filter stop) on EVERY request that replays
 * it. The thread becomes permanently unrunnable: each resume replays the
 * poisoned context, dies on the first model call, and — before layer 1 of
 * this fix — surfaced only "An unknown error occurred".
 *
 * Layers implemented here:
 * - detection: classify provider-abort error messages and
 *   instant-first-model-call failures (`isProviderContentAbortMessage`,
 *   `isInstantFirstCallFailure`).
 * - deterministic-abort containment: after two consecutive instant aborts on
 *   the same session, surface a distinct error naming the suspect trailing
 *   thread entries instead of a generic failure.
 * - self-heal: on the following resume, quarantine the newest un-quarantined
 *   tool-result entry from the *request assembly only* (the persisted thread
 *   record stays intact) and let the run retry. One new entry per resume,
 *   newest-first — tool results are where quoted external content lands.
 * - safety model swap (fable-5 → opus-4.8): fable-5 has strict safety
 *   guardrails with frequent false positives. When a run on a fable-5 route
 *   dies with a provider content abort, `buildSafetyAbortSwapRoute` derives
 *   an opus-4.8 route on the same auth path so the caller can retry that run
 *   once on the swapped model. The swap is per-run only; it never changes
 *   the configured model.
 */

/** Placeholder that replaces quarantined content in the request assembly. */
export const QUARANTINE_PLACEHOLDER =
  "[content quarantined: triggered provider abort]";

const QUARANTINE_NOTE =
  `${QUARANTINE_PLACEHOLDER} — the original content of this entry repeatedly ` +
  "caused the model provider to abort the stream while replaying thread " +
  "history. It was removed from the model request only; the stored thread " +
  "record is unchanged.";

/** Consecutive instant first-call failures before containment engages. */
export const DETERMINISTIC_ABORT_THRESHOLD = 2;

/** Trailing thread entries named as suspects in the deterministic-abort error. */
const SUSPECT_TAIL_ENTRIES = 8;

/**
 * Error-message fingerprints of provider-side content aborts. Sources:
 * - `providerAbortedStopMessage` (runtime/ai/utils/provider-stop.ts), the
 *   normalized layer-1 message carrying the raw stop reason.
 * - `anomalousStreamStopError`'s no-detail fallback.
 * - openai-completions' pre-existing content-filter / error-stop messages.
 * - the legacy opaque string, so threads poisoned before layer 1 shipped
 *   still classify.
 * Context-overflow and connection errors intentionally do NOT match: they
 * have their own handling (compaction, provider retry).
 */
const PROVIDER_ABORT_ERROR_PATTERNS: RegExp[] = [
  /provider aborted the response/i,
  /provider stream ended with stopReason/i,
  /provider finish_reason: content_filter/i,
  /provider returned an error stop reason/i,
  /^an unknown error occurred$/i,
];

export const isProviderContentAbortMessage = (
  message: string | undefined,
): boolean => {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  return PROVIDER_ABORT_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
};

type AssistantEntry = Extract<AgentMessage, { role: "assistant" }>;

/**
 * True when a run died on its FIRST model call: the messages appended during
 * the run contain exactly one assistant message, it errored, and no tool ever
 * executed. This is the fingerprint of poisoned *existing* context — the
 * provider aborted while replaying history, before the run did any new work.
 */
export const isInstantFirstCallFailure = (
  appended: AgentMessage[],
): boolean => {
  const assistants = appended.filter(
    (message): message is AssistantEntry => message.role === "assistant",
  );
  const hasToolResults = appended.some(
    (message) => message.role === "toolResult",
  );
  return (
    !hasToolResults &&
    assistants.length === 1 &&
    (assistants[0].stopReason === "error" ||
      assistants[0].stopReason === "aborted")
  );
};

type QuarantineRecord = {
  key: string;
  toolName: string;
  timestamp: number;
};

const toolResultQuarantineKey = (
  message: Extract<AgentMessage, { role: "toolResult" }>,
): string => `${message.timestamp}:${message.toolCallId}`;

const describeHistoryEntry = (message: AgentMessage, index: number): string => {
  const role =
    message.role === "toolResult"
      ? `toolResult:${message.toolName}`
      : message.role;
  const timestamp =
    typeof message.timestamp === "number" && message.timestamp > 0
      ? new Date(message.timestamp).toISOString()
      : "unknown-time";
  return `#${index} ${role} @ ${timestamp}`;
};

export type QuarantineApplication = {
  /** Previously quarantined entries re-masked after a history reload. */
  reappliedKeys: string[];
  /** Entry newly masked this turn, if the quarantine threshold was met. */
  newlyQuarantined: QuarantineRecord | null;
};

export type ContainmentFailureInput = {
  /** Messages that were already in the context when the run started. */
  history: AgentMessage[];
  /** Messages appended during the failed run (prompt + partial output). */
  appended: AgentMessage[];
  /** The surfaced error message for the failed run. */
  errorMessage: string;
  /** Set when the failure persisted through a safety model swap retry. */
  swapAttempted?: { fromModelId: string; toModelId: string } | undefined;
};

/**
 * Per-session (per durable thread) tracker for deterministic provider
 * aborts, with an in-memory quarantine registry for the self-heal pass.
 */
export class ProviderAbortContainment {
  private consecutiveInstantAborts = 0;
  private lastAbortErrorMessage: string | undefined;
  private readonly quarantined = new Map<string, QuarantineRecord>();

  get consecutiveInstantAbortCount(): number {
    return this.consecutiveInstantAborts;
  }

  get quarantinedCount(): number {
    return this.quarantined.size;
  }

  /**
   * True once the session has seen enough consecutive instant aborts that
   * the next run should quarantine a suspect entry before prompting.
   */
  get shouldQuarantine(): boolean {
    return this.consecutiveInstantAborts >= DETERMINISTIC_ABORT_THRESHOLD;
  }

  noteRunSuccess(): void {
    // Keep the quarantine registry: a success after masking proves the
    // masked content was the trigger, and future history reloads must
    // re-mask it or the thread re-poisons itself.
    this.consecutiveInstantAborts = 0;
    this.lastAbortErrorMessage = undefined;
  }

  /**
   * Record a failed run. Returns the error message to surface: the original
   * one, or — once the deterministic-abort threshold is reached — a distinct
   * containment error naming the suspect trailing thread entries.
   */
  noteRunFailure(input: ContainmentFailureInput): string {
    const providerAbort = isProviderContentAbortMessage(input.errorMessage);
    const instant = isInstantFirstCallFailure(input.appended);
    if (!providerAbort || !instant) {
      this.consecutiveInstantAborts = 0;
      this.lastAbortErrorMessage = undefined;
      return input.errorMessage;
    }

    this.consecutiveInstantAborts += 1;
    this.lastAbortErrorMessage = input.errorMessage;
    if (this.consecutiveInstantAborts < DETERMINISTIC_ABORT_THRESHOLD) {
      return input.errorMessage;
    }
    return this.describeDeterministicAbort(input);
  }

  /**
   * Mask quarantined entries in the live request-assembly message array.
   * Re-masks previously quarantined entries (history reloads rebuild the
   * array from the intact store) and, when the threshold is met, masks the
   * newest un-quarantined tool-result entry as the next suspect.
   * Mutates `messages` in place; never touches persisted records.
   */
  applyQuarantine(messages: AgentMessage[]): QuarantineApplication {
    const reappliedKeys: string[] = [];
    for (const message of messages) {
      if (message.role !== "toolResult") continue;
      const key = toolResultQuarantineKey(message);
      if (!this.quarantined.has(key)) continue;
      if (maskToolResult(message)) {
        reappliedKeys.push(key);
      }
    }

    if (!this.shouldQuarantine) {
      return { reappliedKeys, newlyQuarantined: null };
    }

    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "toolResult") continue;
      const key = toolResultQuarantineKey(message);
      if (this.quarantined.has(key)) continue;
      maskToolResult(message);
      const record: QuarantineRecord = {
        key,
        toolName: message.toolName,
        timestamp: message.timestamp,
      };
      this.quarantined.set(key, record);
      return { reappliedKeys, newlyQuarantined: record };
    }

    return { reappliedKeys, newlyQuarantined: null };
  }

  private describeDeterministicAbort(input: ContainmentFailureInput): string {
    const tail = input.history.slice(-SUSPECT_TAIL_ENTRIES);
    const baseIndex = input.history.length - tail.length;
    const suspects = tail
      .map((message, offset) => describeHistoryEntry(message, baseIndex + offset))
      .join(", ");
    const swapNote = input.swapAttempted
      ? ` An automatic retry on ${input.swapAttempted.toModelId} (after the safety abort on ${input.swapAttempted.fromModelId}) failed the same way, so this is not model-specific.`
      : "";
    const healNote = this.shouldQuarantine
      ? ` On the next resume Stella will quarantine the newest suspect tool-result entry from the model request (${this.quarantined.size} quarantined so far; stored thread history is preserved).`
      : "";
    return (
      `Thread context triggers a provider abort deterministically: ${this.consecutiveInstantAborts} consecutive runs died on the first model call while replaying existing thread history, before any new work happened. ` +
      `Provider error: ${this.lastAbortErrorMessage ?? input.errorMessage} ` +
      `Suspect content is in the trailing thread entries: ${suspects || "(no history entries)"}.` +
      swapNote +
      healNote
    );
  }
}

const maskToolResult = (
  message: Extract<AgentMessage, { role: "toolResult" }>,
): boolean => {
  const alreadyMasked =
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text.startsWith(QUARANTINE_PLACEHOLDER);
  if (alreadyMasked) return false;
  message.content = [{ type: "text", text: QUARANTINE_NOTE }];
  // Details can carry the same offending payload (and can be huge); drop
  // them from the request assembly too.
  delete message.details;
  return true;
};

// ---------------------------------------------------------------------------
// Safety model swap: fable-5 → opus-4.8
// ---------------------------------------------------------------------------

const FABLE_MODEL_RE = /fable-5/i;

/** Stella-relay requested id for the swap target (Rahul's auth path). */
export const SAFETY_SWAP_STELLA_MODEL_ID = "stella/anthropic/claude-opus-4.8";
const SAFETY_SWAP_STELLA_UPSTREAM_ID = "claude-opus-4.8";

type ModelWithUpstream = Model<Api> & { upstreamModelId?: string };

const upstreamModelIdOf = (model: Model<Api>): string =>
  (model as ModelWithUpstream).upstreamModelId ?? model.id;

/** True when the route ultimately hits claude-fable-5, via any alias. */
export const isFable5Route = (route: ResolvedLlmRoute): boolean =>
  FABLE_MODEL_RE.test(route.model.id) ||
  FABLE_MODEL_RE.test(upstreamModelIdOf(route.model));

export type SafetySwapRoute = {
  route: ResolvedLlmRoute;
  fromModelId: string;
  toModelId: string;
};

/**
 * Derive an opus-4.8 route from a failing fable-5 route, preserving the
 * auth path (relay base URL, headers, token getters). Returns null when the
 * current route is not fable-5 or no safe id rewrite exists.
 *
 * Cost/context metadata is inherited from the fable route — both are
 * Anthropic flagship models, and per-run retry accuracy matters less than
 * not dying.
 */
export const buildSafetyAbortSwapRoute = (
  current: ResolvedLlmRoute,
): SafetySwapRoute | null => {
  if (!isFable5Route(current)) return null;

  const fromModelId = current.model.id;
  if (current.route === "stella") {
    const model: ModelWithUpstream = {
      ...(current.model as ModelWithUpstream),
      id: SAFETY_SWAP_STELLA_MODEL_ID,
      name: SAFETY_SWAP_STELLA_MODEL_ID.replace(/^stella\//, ""),
      upstreamModelId: SAFETY_SWAP_STELLA_UPSTREAM_ID,
    };
    return {
      route: { ...current, model },
      fromModelId,
      toModelId: model.id,
    };
  }

  // Direct-provider routes: rewrite the fable slug in place so the provider,
  // API family, and credentials all stay the same.
  // - openrouter-style: anthropic/claude-fable-5 → anthropic/claude-opus-4.8
  // - native anthropic: claude-fable-5 → claude-opus-4-8 (registry id shape)
  const toModelId = current.model.id.includes("/")
    ? current.model.id.replace(FABLE_MODEL_RE, "opus-4.8")
    : current.model.id.replace(FABLE_MODEL_RE, "opus-4-8");
  if (toModelId === current.model.id) return null;

  const model: ModelWithUpstream = {
    ...(current.model as ModelWithUpstream),
    id: toModelId,
    name: toModelId,
  };
  if ((current.model as ModelWithUpstream).upstreamModelId) {
    model.upstreamModelId = (
      current.model as ModelWithUpstream
    ).upstreamModelId!.replace(FABLE_MODEL_RE, "opus-4.8");
  }
  return {
    route: { ...current, model },
    fromModelId,
    toModelId,
  };
};

/** Human-readable note recorded on the run when the swap fires. */
export const safetySwapStatusMessage = (swap: {
  fromModelId: string;
  toModelId: string;
}): string =>
  `provider safety abort on ${swap.fromModelId} — auto-retried on ${swap.toModelId}`;
