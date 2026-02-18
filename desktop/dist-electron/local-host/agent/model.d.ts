/**
 * Centralized model configuration for all AI requests.
 * Mirrors backend/convex/agent/model.ts for local agent runtime.
 */
export type ModelConfig = {
    model: string;
    fallback?: string;
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: {
        gateway?: {
            only?: string[];
            order?: string[];
        };
        deepinfra?: {
            dimensions?: number;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
};
declare const DEFAULT_MODEL: ModelConfig;
declare const AGENT_MODELS: Record<string, ModelConfig>;
export declare function getModelConfig(agentType: string): ModelConfig;
export { DEFAULT_MODEL, AGENT_MODELS };
