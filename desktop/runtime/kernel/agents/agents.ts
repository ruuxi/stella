import type { ParsedAgent } from "./types.js";
import { buildBundledCoreAgents } from "./core-agent-prompts.js";
import { getAgentDefinition } from "../../../src/shared/contracts/agent-runtime.js";

export const loadBundledAgents = (): ParsedAgent[] =>
  buildBundledCoreAgents().filter(
    (agent) => getAgentDefinition(agent.id)?.includeInAgentRoster !== false,
  );

/** Resolved when `agentType` is internal-only (not in `loadBundledAgents`). */
export const getBundledCoreAgentFallback = (
  agentType: string,
): ParsedAgent | undefined => {
  if (getAgentDefinition(agentType)?.includeInAgentRoster !== false) {
    return undefined;
  }
  return buildBundledCoreAgents().find(
    (agent) => agent.id === agentType || agent.agentTypes.includes(agentType),
  );
};
