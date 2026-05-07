import { agentHasCapability } from "../../../contracts/agent-runtime.js";
import type { HookDefinition } from "../../../kernel/extensions/types.js";
import type { SelfModMonitor } from "../../../kernel/agent-runtime/types.js";

type BaselineCache = Map<string, string | null>;

const shouldRun = (agentType: string, isUserTurn?: boolean): boolean =>
  isUserTurn !== false &&
  agentHasCapability(agentType, "triggersSelfModDetection");

/**
 * Self-modification baseline + detect-applied (stella-runtime).
 *
 * A pair of hooks that bookend the run:
 *
 *   before_agent_start  → snapshot the repo HEAD into a runId-keyed cache.
 *   agent_end           → diff HEAD against the cached baseline and return
 *                          the resulting `selfModApplied` payload so the
 *                          runtime can thread it onto the outgoing
 *                          RuntimeEndEvent (drives the morph overlay).
 *
 * Gated by the `triggersSelfModDetection` capability and `isUserTurn`.
 * Synthetic hidden turns and capability-less agents skip both hooks.
 * The detection only runs on `outcome === "success"`; error / interrupted
 * runs still hit `agent_end` so the cache can be reclaimed.
 *
 * Lives in the stella-runtime extension; `stellaRoot` and
 * `selfModMonitor` are supplied by the extension factory's services arg.
 */
export const createSelfModHooks = (opts: {
  stellaRoot: string;
  selfModMonitor: SelfModMonitor | null;
}): HookDefinition[] => {
  // Per-runId baseline cache. Cleaned up at agent_end (success or error
  // path — see fix history). If a run never fires agent_end (process
  // crash mid-flight) the entry leaks until process exit; bounded.
  const baselines: BaselineCache = new Map();

  const beforeAgentStart: HookDefinition<"before_agent_start"> = {
    event: "before_agent_start",
    async handler(payload) {
      if (!opts.selfModMonitor || !opts.stellaRoot) return;
      if (!shouldRun(payload.agentType, payload.isUserTurn)) return;
      if (!payload.runId) return;

      try {
        const head = await opts.selfModMonitor.getBaselineHead(opts.stellaRoot);
        baselines.set(payload.runId, head);
      } catch {
        // Avoid attributing unrelated changes when baseline capture fails.
        baselines.set(payload.runId, null);
      }
      return;
    },
  };

  const agentEnd: HookDefinition<"agent_end"> = {
    event: "agent_end",
    async handler(payload) {
      if (!payload.runId) return;

      const baseline = baselines.has(payload.runId)
        ? baselines.get(payload.runId) ?? null
        : null;
      const hadEntry = baselines.delete(payload.runId);

      if (!opts.selfModMonitor || !opts.stellaRoot) return;
      if (!shouldRun(payload.agentType, payload.isUserTurn)) return;
      // Treats undefined as non-success so a third-party emitter that
      // omits `outcome` doesn't accidentally trigger the expensive
      // detect-applied path.
      if (payload.outcome !== "success") return;
      if (!hadEntry) return;

      try {
        const applied = await opts.selfModMonitor.detectAppliedSince({
          repoRoot: opts.stellaRoot,
          sinceHead: baseline,
        });
        if (applied) {
          return { selfModApplied: applied };
        }
      } catch {
        // Detection failures must not break the finalize path.
      }
      return;
    },
  };

  return [beforeAgentStart, agentEnd];
};
