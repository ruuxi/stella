/**
 * Local model resolver — resolves per-agent model config with BYOK support.
 * Reads preferences and secrets from local SQLite instead of Convex.
 *
 * BYOK chain: Direct provider key → OpenRouter → AI Gateway → Stella AI Proxy
 */
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
export type ResolvedModelConfig = {
    model: string | LanguageModel;
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: ProviderOptions;
};
/**
 * Resolve the model config for an agent type, applying user overrides and BYOK.
 */
export declare function resolveModelConfig(agentType: string, ownerId?: string): ResolvedModelConfig;
/**
 * Resolve a fallback model config.
 */
export declare function resolveFallbackConfig(agentType: string, ownerId?: string): ResolvedModelConfig | null;
