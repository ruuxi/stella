import type { ParsedAgent } from "./manifests.js";
import { listMarkdownFiles, parseAgentMarkdown } from "./manifests.js";

export const loadAgentsFromHome = async (
  agentsPath: string,
): Promise<ParsedAgent[]> => {
  const localAgentFiles = await listMarkdownFiles(agentsPath, "AGENT.md");
  const localAgents: ParsedAgent[] = [];

  for (const filePath of localAgentFiles) {
    const agent = await parseAgentMarkdown(filePath, "local");
    if (agent) localAgents.push(agent);
  }

  return localAgents;
};
