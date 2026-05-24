import { existsSync } from "node:fs";
import type { ParsedAgent } from "./types.js";
import {
  BUNDLED_CORE_AGENT_IDS,
  getAgentDefinition,
} from "../../contracts/agent-runtime.js";
import { loadParsedAgentsFromDir } from "./markdown-agent-loader.js";

const BUNDLED_AGENT_DIRS = [
  new URL("../../extensions/stella-runtime/agents/", import.meta.url),
  new URL("../extensions/stella-runtime/agents/", import.meta.url),
];

const BUNDLED_AGENT_ORDER = new Map<string, number>(
  BUNDLED_CORE_AGENT_IDS.map((agentId, index) => [agentId, index]),
);

const resolveBundledAgentDir = (): URL =>
  BUNDLED_AGENT_DIRS.find((candidate) => existsSync(candidate)) ??
  BUNDLED_AGENT_DIRS[0]!;

export const loadBundledAgents = (): ParsedAgent[] =>
  loadParsedAgentsFromDir(resolveBundledAgentDir())
    .filter(
      (agent) => getAgentDefinition(agent.id)?.includeInAgentRoster !== false,
    )
    .sort((left, right) => {
      const leftOrder =
        BUNDLED_AGENT_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        BUNDLED_AGENT_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });

/** Resolved when `agentType` is internal-only (not in `loadBundledAgents`). */
export const getBundledCoreAgentFallback = (
  agentType: string,
): ParsedAgent | undefined => {
  if (getAgentDefinition(agentType)?.includeInAgentRoster !== false) {
    return undefined;
  }
  return loadParsedAgentsFromDir(resolveBundledAgentDir()).find(
    (agent) => agent.id === agentType || agent.agentTypes.includes(agentType),
  );
};
