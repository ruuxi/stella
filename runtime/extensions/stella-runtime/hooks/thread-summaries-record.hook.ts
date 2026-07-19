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
      // Two-phase Dream-inbox stamp, phase 1: the row is ALWAYS recorded
      // without a reporting conversation. At finalize time the terminal
      // report has not persisted anywhere yet — and for superseded
      // (send_input race), adopted, or crash-interrupted runs it never
      // will — so no stamp taken here can honestly claim "the orchestrator
      // window holds this content". The stamp is promoted later by the
      // lifecycle handler's orchestrator-persist branch, immediately after
      // it durably writes the report (agent-orchestration.ts). Until then
      // the row is visible to the model-driven Dream list and untouchable
      // by mechanical delta consumption.
      opts.store.dreamInboxStore.recordThreadSummary({
        threadId: payload.threadKey,
        runId: payload.runId,
        agentType: payload.agentType,
        rolloutSummary: payload.finalText,
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
