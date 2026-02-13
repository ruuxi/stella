/**
 * Skill Import System
 *
 * Imports skills from ~/.claude/skills/ and ~/.agents/skills/ into ~/.stella/skills/,
 * generating stella.yaml metadata files via LLM.
 */
export type SkillImportRecord = {
    sourceDir: string;
    sourceHash: string;
    importedAt: number;
    priority: "claude" | "agents" | "anthropic";
};
export type SkillImportIndex = {
    version: 1;
    imports: Record<string, SkillImportRecord>;
};
export type StellaYaml = {
    id: string;
    name: string;
    description: string;
    agentTypes: string[];
    version: number;
    source: "claude" | "agents" | "anthropic";
    enabled?: boolean;
    importedAt: number;
};
export type DiscoveredSkill = {
    id: string;
    dirName: string;
    sourceDir: string;
    skillMdPath: string;
    priority: "claude" | "agents" | "anthropic";
};
export type SkillImportPlan = DiscoveredSkill & {
    sourceHash: string;
};
export type GenerateMetadataFn = (markdown: string, dirName: string) => Promise<{
    metadata: {
        id: string;
        name: string;
        description: string;
        agentTypes: string[];
    };
}>;
export declare const loadImportIndex: (statePath: string) => Promise<SkillImportIndex>;
export declare const saveImportIndex: (statePath: string, index: SkillImportIndex) => Promise<void>;
export declare const discoverSkillsFromSource: (sourceDir: string, priority: "claude" | "agents" | "anthropic") => Promise<DiscoveredSkill[]>;
export declare const getSkillsToImport: (claudeSkills: DiscoveredSkill[], agentsSkills: DiscoveredSkill[], importIndex: SkillImportIndex, existingStellaIds: Set<string>) => Promise<SkillImportPlan[]>;
export declare const syncExternalSkills: (claudeSkillsPath: string, agentsSkillsPath: string, stellaSkillsPath: string, statePath: string, generateMetadata: GenerateMetadataFn) => Promise<void>;
export declare const syncBundledSkills: (bundledSourcePath: string, stellaSkillsPath: string, statePath: string) => Promise<void>;
