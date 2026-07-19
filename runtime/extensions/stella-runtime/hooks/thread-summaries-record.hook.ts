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
        // Reporting conversation — spawn-site VERIFIED (services field, not
        // payload.conversationId): every subagent agent_end carries the root
        // conversation id, but a manager-owned child's terminal report
        // persists only to the manager's thread, never the orchestrator
        // window the step-6 delta reads. Only runs whose ancestry the spawn
        // site resolved to the orchestrator get stamped; everything else
        // stays NULL and flows through the model-driven Dream list path.
        ...(payload.services.dreamReportingConversationId
          ? {
              conversationId: payload.services.dreamReportingConversationId,
            }
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
