import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

const logger = createRuntimeLogger("stella-runtime.thread-summaries-record");

/**
 * Thread-summaries record (stella-runtime).
 *
 * Queues one Dream-inbox row per finalized subagent run
 * (`store.dreamInboxStore`, kind `thread_summary`). Dream's scheduler later
 * consumes the inbox to build longer-horizon summaries; the
 * dream-scheduler-notify hook is the trigger, this hook is the source.
 *
 * Pre-migration this was an inline branch inside
 * `finalizeSubagentSuccess` gated on
 * `agentHasCapability(agentType, "recordsThreadSummary")` — same
 * gate, just relocated to the hook.
 *
 * Service deps:
 *   - `store` (factory-time, closure).
 */
export const createThreadSummariesRecordHook = (opts: {
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "recordsThreadSummary")) return;
    if (!payload.runId || !payload.threadKey) return;
    // `services` populated only when side-effects are allowed; absence
    // means this is a one-shot internal call (e.g. commit-subject
    // namer) and we self-skip.
    if (!payload.services) return;

    try {
      opts.store.dreamInboxStore.recordThreadSummary({
        threadId: payload.threadKey,
        runId: payload.runId,
        agentType: payload.agentType,
        rolloutSummary: payload.finalText,
        // Reporting conversation (subagents: the parent's) — the thread
        // whose window carries the byte-equivalent report. Lets the
        // delta-input pass mechanically consume this row ONLY when its own
        // delta provably covers it.
        ...(payload.conversationId
          ? { conversationId: payload.conversationId }
          : {}),
      });
    } catch (error) {
      logger.debug("thread-summaries.record-failed", {
        threadKey: payload.threadKey,
        runId: payload.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  },
});
