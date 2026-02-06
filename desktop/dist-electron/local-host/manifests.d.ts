export type ParsedSkill = {
    id: string;
    name: string;
    description: string;
    markdown: string;
    agentTypes: string[];
    toolsAllowlist?: string[];
    tags?: string[];
    execution?: "backend" | "device";
    requiresSecrets?: string[];
    publicIntegration?: boolean;
    secretMounts?: {
        env?: Record<string, {
            provider: string;
            label?: string;
            description?: string;
            placeholder?: string;
        }>;
        files?: Record<string, {
            provider: string;
            label?: string;
            description?: string;
            placeholder?: string;
        }>;
    };
    version: number;
    source: string;
    filePath: string;
};
export type ParsedAgent = {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    agentTypes: string[];
    toolsAllowlist?: string[];
    defaultSkills?: string[];
    model?: string;
    maxTaskDepth?: number;
    version: number;
    source: string;
    filePath: string;
};
export declare const parseSkillMarkdown: (filePath: string, source: string) => Promise<ParsedSkill | null>;
export declare const parseAgentMarkdown: (filePath: string, source: string) => Promise<ParsedAgent | null>;
export declare const listMarkdownFiles: (baseDir: string, expectedName: string) => Promise<string[]>;
