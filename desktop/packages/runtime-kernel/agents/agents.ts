import type { ParsedAgent } from "./manifests.js";
import { buildBundledCoreAgents } from "./core-agent-prompts.js";
import { listMarkdownFiles, parseAgentMarkdown } from "./manifests.js";
import { getAgentDefinition } from "../../../src/shared/contracts/agent-runtime.js";

export const loadAgentsFromHome = async (
  agentsPath: string,
): Promise<ParsedAgent[]> => {
  const localAgentFiles = await listMarkdownFiles(agentsPath, "AGENT.md");
  const localAgents: ParsedAgent[] = [];

  for (const filePath of localAgentFiles) {
    const agent = await parseAgentMarkdown(filePath, "local");
    if (agent) localAgents.push(agent);
  }

  const localAgentIds = new Set(localAgents.map((agent) => agent.id));
  const localAgentTypes = new Set(localAgents.flatMap((agent) => agent.agentTypes));
  const bundledAgents = buildBundledCoreAgents().filter((agent) => {
    if (getAgentDefinition(agent.id)?.includeInAgentRoster === false) {
      return false;
    }
    if (localAgentIds.has(agent.id)) {
      return false;
    }
    return !agent.agentTypes.some((agentType) => localAgentTypes.has(agentType));
  });

  return [...localAgents, ...bundledAgents];
};

/** Resolved when `agentType` is internal-only (not in `loadAgentsFromHome`). */
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
