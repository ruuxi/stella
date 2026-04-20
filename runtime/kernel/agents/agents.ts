import type { ParsedAgent } from "./types.js";
import {
  BUNDLED_CORE_AGENT_IDS,
  getAgentDefinition,
} from "../../../desktop/src/shared/contracts/agent-runtime.js";
import { loadParsedAgentsFromDir } from "./markdown-agent-loader.js";

const BUNDLED_AGENT_DIR = new URL(
  "../../extensions/stella-runtime/agents/",
  import.meta.url,
);

const BUNDLED_AGENT_ORDER = new Map(
  BUNDLED_CORE_AGENT_IDS.map((agentId, index) => [agentId, index]),
);

export const loadBundledAgents = (): ParsedAgent[] =>
  loadParsedAgentsFromDir(BUNDLED_AGENT_DIR)
    .filter((agent) => getAgentDefinition(agent.id)?.includeInAgentRoster !== false)
    .sort((left, right) => {
      const leftOrder = BUNDLED_AGENT_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = BUNDLED_AGENT_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });

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
