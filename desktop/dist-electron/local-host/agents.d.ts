import type { ParsedAgent } from "./manifests.js";
export declare const loadAgentsFromHome: (agentsPath: string, pluginAgents: ParsedAgent[]) => Promise<ParsedAgent[]>;
