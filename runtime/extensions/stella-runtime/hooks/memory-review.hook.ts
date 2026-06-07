import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import {
  MEMORY_REVIEW_TURN_THRESHOLD,
  spawnMemoryReview,
} from "../../../kernel/agent-runtime/memory-review.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";
import { THREAD_COMPACTION_TRIGGER_TOKENS } from "../../../kernel/thread-runtime.js";

/**
 * Background memory review (stella-runtime).
 *
 * Fires after a successful Orchestrator turn whenever the
 * memory-review counter (`prepareOrchestratorRun` increments it on
 * every real user turn for agents that declare `triggersMemoryReview`)
 * has reached threshold. The review is a fire-and-forget LLM pass that
 * sees the recent user/assistant transcript and may write a gated memory
 * candidate under `memories_extensions/orchestrator_review` for Dream to
 * consolidate.
 *
 * Pre-migration this was an inline branch inside
 * `finalizeOrchestratorSuccess`. Moving it to a hook keeps the kernel
 * agnostic about Stella's memory product and lets users disable or
 * fork the review without editing kernel code.
 *
 * Service deps:
 *   - `store`, `stellaDataDir`, `stellaAppDir` (factory-time, closure).
 *   - `payload.services.resolvedLlm` (per-turn) — drives the review
 *     completion.
 *   - `payload.services.messagesSnapshot` (per-turn) — transcript the
 *     review reads.
 *   - `payload.services.userTurnsSinceMemoryReview` (per-turn) — the
 *     counter to compare against threshold.
 */
export const createMemoryReviewHook = (opts: {
  stellaDataDir: string;
  stellaAppDir: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "triggersMemoryReview")) return;
    const services = payload.services;
    if (!services) return;
    if (!services.resolvedLlm) return;
    if (!services.messagesSnapshot) return;
    if (!payload.conversationId) return;

    // Capture on the normal cadence (every N turns), OR force a capture when a
    // compaction is imminent so the about-to-be-summarized window is reviewed
    // before its detail is replaced by the summary. The frozen messagesSnapshot
    // means the review reads the pre-compaction detail even though the actual
    // compaction runs asynchronously after this hook.
    const turns = services.userTurnsSinceMemoryReview;
    const reachedTurnThreshold =
      turns != null && turns >= MEMORY_REVIEW_TURN_THRESHOLD;
    const tokenEstimate = services.orchestratorTokenEstimate;
    const compactionImminent =
      typeof tokenEstimate === "number" &&
      tokenEstimate >= THREAD_COMPACTION_TRIGGER_TOKENS;
    if (!reachedTurnThreshold && !compactionImminent) return;

    // Read the previous watermark before spawnMemoryReview advances it, so the
    // pass reviews only messages created since the last review.
    const { lastReviewedMessageTs } = opts.store.getMemoryReviewState(
      payload.conversationId,
    );

    spawnMemoryReview({
      conversationId: payload.conversationId,
      stellaDataDir: opts.stellaDataDir,
      stellaAppDir: opts.stellaAppDir,
      messagesSnapshot: services.messagesSnapshot,
      sinceMessageTs: lastReviewedMessageTs,
      resolvedLlm: services.resolvedLlm,
      store: opts.store,
    });
    return;
  },
});
