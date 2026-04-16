import type { ParsedAgent } from "./types.js";
import { getAgentDefinition } from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { loadParsedAgentsFromDir } from "./markdown-agent-loader.js";

const BUNDLED_AGENT_DIR = new URL(
  "../../extensions/stella-runtime/agents/",
  import.meta.url,
);

export const loadBundledAgents = (): ParsedAgent[] =>
  loadParsedAgentsFromDir(BUNDLED_AGENT_DIR).filter(
    (agent) => getAgentDefinition(agent.id)?.includeInAgentRoster !== false,
  );

/** Resolved when `agentType` is internal-only (not in `loadBundledAgents`). */
export const getBundledCoreAgentFallback = (
  agentType: string,
): ParsedAgent | undefined => {
  if (getAgentDefinition(agentType)?.includeInAgentRoster !== false) {
    return undefined;
  }
  return loadParsedAgentsFromDir(BUNDLED_AGENT_DIR).find(
    (agent) => agent.id === agentType || agent.agentTypes.includes(agentType),
  );
};
