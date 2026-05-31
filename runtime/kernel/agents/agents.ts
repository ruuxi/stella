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

const agentKeys = (agent: ParsedAgent): Set<string> =>
  new Set([agent.id, ...agent.agentTypes]);

const agentsOverlap = (left: ParsedAgent, right: ParsedAgent): boolean => {
  const leftKeys = agentKeys(left);
  for (const key of agentKeys(right)) {
    if (leftKeys.has(key)) {
      return true;
    }
  }
  return false;
};

export const mergeBundledAndExtensionAgents = (
  extensionAgents: readonly ParsedAgent[],
): ParsedAgent[] => {
  const merged = loadBundledAgents();
  for (const extensionAgent of extensionAgents) {
    const index = merged.findIndex((agent) =>
      agentsOverlap(agent, extensionAgent),
    );
    if (index >= 0) {
      merged[index] = extensionAgent;
      continue;
    }
    merged.push(extensionAgent);
  }
  return merged;
};

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
