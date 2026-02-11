import { listMarkdownFiles, parseAgentMarkdown } from "./manifests.js";
export const loadAgentsFromHome = async (agentsPath) => {
    const localAgentFiles = await listMarkdownFiles(agentsPath, "AGENT.md");
    const localAgents = [];
    for (const filePath of localAgentFiles) {
        const agent = await parseAgentMarkdown(filePath, "local");
        if (agent)
            localAgents.push(agent);
    }
    return localAgents;
};
