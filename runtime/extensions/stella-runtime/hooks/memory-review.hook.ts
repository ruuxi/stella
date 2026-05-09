import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import {
  MEMORY_REVIEW_TURN_THRESHOLD,
  spawnMemoryReview,
} from "../../../kernel/agent-runtime/memory-review.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

/**
 * Background memory review (stella-runtime).
 *
 * Fires after a successful Orchestrator turn whenever the
 * memory-review counter (`prepareOrchestratorRun` increments it on
 * every real user turn for agents that declare `triggersMemoryReview`)
 * has reached threshold. The review is a fire-and-forget LLM pass that
 * sees the recent transcript and decides what to record into the
 * MemoryStore.
 *
 * Pre-migration this was an inline branch inside
 * `finalizeOrchestratorSuccess`. Moving it to a hook keeps the kernel
 * agnostic about Stella's memory product and lets users disable or
 * fork the review without editing kernel code.
 *
 * Service deps:
 *   - `store` (factory-time, closure) — shared MemoryStore lives on it.
 *   - `payload.services.resolvedLlm` (per-turn) — drives the review
 *     completion.
 *   - `payload.services.messagesSnapshot` (per-turn) — transcript the
 *     review reads.
 *   - `payload.services.userTurnsSinceMemoryReview` (per-turn) — the
 *     counter to compare against threshold.
 */
export const createMemoryReviewHook = (opts: {
  stellaRoot: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "triggersMemoryReview")) return;
    const services = payload.services;
    if (!services) return;
    const turns = services.userTurnsSinceMemoryReview;
    if (turns == null || turns < MEMORY_REVIEW_TURN_THRESHOLD) return;
    if (!services.resolvedLlm) return;
    if (!services.messagesSnapshot) return;
    if (!payload.conversationId) return;

    spawnMemoryReview({
      conversationId: payload.conversationId,
      stellaRoot: opts.stellaRoot,
      messagesSnapshot: services.messagesSnapshot,
      resolvedLlm: services.resolvedLlm,
      store: opts.store,
    });
    return;
  },
});
