import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { RuntimeStore } from "../../../kernel/storage/runtime-store.js";

const logger = createRuntimeLogger("stella-runtime.dream-notify");

/**
 * Dream scheduler notify (stella-runtime).
 *
 * Pings Stella's Dream scheduler when a successful subagent finalize
 * lands for an agent that declares `triggersDreamScheduler` (today
 * only the General agent). Dream consumes thread summaries to build
 * Stella's longer-horizon "what happened across runs" memory; this
 * hook just signals "fresh material is available" — Dream itself
 * decides whether to actually run based on its own eligibility gates.
 *
 * Pre-migration this was an inline branch inside
 * `finalizeSubagentSuccess`. The hook self-skips when
 * `payload.services` is absent (cleanup-only emits, suppressed
 * side-effects) so the same emit point can drive both the lifecycle
 * cleanup and the side-effect-firing path.
 *
 * Service deps:
 *   - `store`, `stellaHome` (factory-time, closure).
 *   - `payload.services.resolvedLlm` (per-turn).
 *   - The `dream-scheduler` module is dynamically imported inside the
 *     handler to avoid pulling its transitive dependency graph into
 *     every cold-start of the runtime worker.
 */
export const createDreamSchedulerNotifyHook = (opts: {
  stellaHome: string;
  store: RuntimeStore;
}): HookDefinition<"agent_end"> => ({
  event: "agent_end",
  async handler(payload) {
    if (payload.outcome !== "success") return;
    if (!agentHasCapability(payload.agentType, "triggersDreamScheduler")) {
      return;
    }
    const services = payload.services;
    if (!services?.resolvedLlm) return;

    try {
      const { maybeSpawnDreamRun } = await import(
        "../../../kernel/agent-runtime/dream-scheduler.js"
      );
      void maybeSpawnDreamRun({
        stellaHome: opts.stellaHome,
        store: opts.store,
        resolvedLlm: services.resolvedLlm,
        trigger: "subagent_finalize",
      }).catch((error) => {
        logger.debug("dream-scheduler.notify-failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      logger.debug("dream-scheduler.notify-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  },
});
