/**
 * Centralized model configuration for all AI requests.
 * Mirrors backend/convex/agent/model.ts for local agent runtime.
 */
const DEFAULT_MODEL = {
    model: "anthropic/claude-opus-4.6",
    fallback: "moonshotai/kimi-k2.5",
    temperature: 1.0,
    maxOutputTokens: 16096,
};
const AGENT_MODELS = {
    orchestrator: {
        model: "anthropic/claude-opus-4.6",
        fallback: "anthropic/claude-opus-4.5",
        temperature: 1.0,
        maxOutputTokens: 16192,
    },
    general: {
        model: "anthropic/claude-opus-4.6",
        fallback: "anthropic/claude-opus-4.5",
        temperature: 1.0,
        maxOutputTokens: 16192,
    },
    explore: {
        model: "zai/glm-4.7",
        fallback: "moonshotai/kimi-k2.5",
        temperature: 1.0,
        maxOutputTokens: 16192,
    },
    browser: {
        model: "moonshotai/kimi-k2.5",
        fallback: "anthropic/claude-sonnet-4-5",
        temperature: 1.0,
        maxOutputTokens: 16192,
    },
    self_mod: {
        model: "anthropic/claude-opus-4.6",
        fallback: "moonshotai/kimi-k2.5",
        temperature: 1.0,
        maxOutputTokens: 16000,
    },
    memory_ops: {
        model: "zai/glm-4.7",
        fallback: "moonshotai/kimi-k2.5",
        temperature: 1.0,
        maxOutputTokens: 12096,
    },
    embedding: {
        model: "alibaba/qwen3-embedding-8b",
        providerOptions: {
            deepinfra: { dimensions: 1536 },
        },
    },
    synthesis: {
        model: "openai/gpt-5.2-codex",
        fallback: "zai/glm-4.7",
        temperature: 1.0,
        maxOutputTokens: 9500,
        providerOptions: {
            openai: { reasoningEffort: "low" },
        },
    },
    suggestions: {
        model: "moonshotai/kimi-k2.5",
        fallback: "zai/glm-4.7",
        temperature: 1.0,
        maxOutputTokens: 10000,
    },
    welcome: {
        model: "anthropic/claude-opus-4.6",
        fallback: "moonshotai/kimi-k2.5",
        temperature: 1.0,
        maxOutputTokens: 10000,
    },
};
export function getModelConfig(agentType) {
    return AGENT_MODELS[agentType] ?? DEFAULT_MODEL;
}
export { DEFAULT_MODEL, AGENT_MODELS };
