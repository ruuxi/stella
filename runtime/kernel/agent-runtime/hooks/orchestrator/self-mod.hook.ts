import { agentHasCapability } from "../../../../contracts/agent-runtime.js";
import type { HookDefinition } from "../../../extensions/types.js";
import type { SelfModMonitor } from "../../types.js";

type BaselineCache = Map<string, string | null>;

const shouldRun = (agentType: string, isUserTurn?: boolean): boolean =>
  isUserTurn !== false &&
  agentHasCapability(agentType, "triggersSelfModDetection");

export const createSelfModHooks = (opts: {
  stellaRoot?: string;
  selfModMonitor?: SelfModMonitor | null;
}): HookDefinition[] => {
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
      }
      return;
    },
  };

  return [beforeAgentStart, agentEnd];
};
