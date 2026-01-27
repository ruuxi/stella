import { listMarkdownFiles, parseAgentMarkdown } from "./manifests.js";
export const loadAgentsFromHome = async (agentsPath, pluginAgents) => {
    const localAgentFiles = await listMarkdownFiles(agentsPath, "AGENT.md");
    const localAgents = [];
    for (const filePath of localAgentFiles) {
        const agent = await parseAgentMarkdown(filePath, "local");
        if (agent)
            localAgents.push(agent);
    }
    // Prefer local agents when IDs collide.
    const byId = new Map();
    for (const agent of pluginAgents) {
        byId.set(agent.id, agent);
    }
    for (const agent of localAgents) {
        byId.set(agent.id, agent);
    }
    return Array.from(byId.values());
};
