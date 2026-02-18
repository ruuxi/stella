/**
 * Local prompt builder — constructs system prompts from SQLite data.
 * Ported from backend/convex/agent/prompt_builder.ts
 */
export type PromptBuildResult = {
    systemPrompt: string;
    dynamicContext: string;
    toolsAllowlist?: string[];
    maxTaskDepth: number;
    defaultSkills: string[];
    skillIds: string[];
};
export declare function buildSystemPrompt(agentType: string, options?: {
    ownerId?: string;
    conversationId?: string;
}): PromptBuildResult;
