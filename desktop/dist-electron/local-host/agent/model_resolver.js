/**
 * Local model resolver — resolves per-agent model config with BYOK support.
 * Reads preferences and secrets from local SQLite instead of Convex.
 *
 * BYOK chain: Direct provider key → OpenRouter → AI Gateway → Stella AI Proxy
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { rawQuery } from "../db";
import { getModelConfig } from "./model";
function extractProvider(modelString) {
    const slash = modelString.indexOf("/");
    if (slash <= 0)
        return null;
    return modelString.slice(0, slash);
}
function extractModelName(modelString) {
    const slash = modelString.indexOf("/");
    if (slash <= 0)
        return modelString;
    return modelString.slice(slash + 1);
}
function createProviderModel(modelString, apiKey) {
    const provider = extractProvider(modelString);
    const modelName = extractModelName(modelString);
    switch (provider) {
        case "anthropic": {
            const anthropic = createAnthropic({ apiKey });
            return anthropic(modelName);
        }
        case "openai": {
            const openai = createOpenAI({ apiKey });
            return openai(modelName);
        }
        case "google": {
            const google = createGoogleGenerativeAI({ apiKey });
            return google(modelName);
        }
        default:
            return null;
    }
}
function createOpenRouterModel(modelString, apiKey) {
    const openrouter = createOpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
    });
    return openrouter(modelString);
}
function filterGatewayOptions(providerOptions) {
    if (!providerOptions)
        return undefined;
    const { gateway, ...rest } = providerOptions;
    return Object.keys(rest).length > 0 ? rest : undefined;
}
function providerToSecretKey(provider) {
    switch (provider) {
        case "anthropic": return "llm:anthropic";
        case "openai": return "llm:openai";
        case "google": return "llm:google";
        default: return null;
    }
}
/** Get a decrypted secret value from local SQLite */
function getLocalSecret(ownerId, provider) {
    const rows = rawQuery("SELECT encrypted_value FROM secrets WHERE owner_id = ? AND provider = ? AND status = 'active' LIMIT 1", [ownerId, provider]);
    if (rows.length === 0)
        return null;
    // In local mode, "encrypted_value" is stored in plaintext since it's on the user's device
    return rows[0].encrypted_value;
}
/** Get a preference value from local SQLite */
function getLocalPreference(ownerId, key) {
    const rows = rawQuery("SELECT value FROM user_preferences WHERE owner_id = ? AND key = ?", [ownerId, key]);
    return rows.length > 0 ? rows[0].value : null;
}
/**
 * Resolve the model config for an agent type, applying user overrides and BYOK.
 */
export function resolveModelConfig(agentType, ownerId) {
    const defaults = getModelConfig(agentType);
    if (!ownerId) {
        return {
            model: defaults.model,
            temperature: defaults.temperature,
            maxOutputTokens: defaults.maxOutputTokens,
            providerOptions: defaults.providerOptions,
        };
    }
    // Check for user model override
    let modelString = defaults.model;
    const override = getLocalPreference(ownerId, `model_config:${agentType}`);
    if (override) {
        modelString = override;
    }
    // BYOK chain:
    // 1. Direct provider key (anthropic, openai, google)
    const provider = extractProvider(modelString);
    if (provider) {
        const secretKey = providerToSecretKey(provider);
        if (secretKey) {
            const apiKey = getLocalSecret(ownerId, secretKey);
            if (apiKey) {
                const directModel = createProviderModel(modelString, apiKey);
                if (directModel) {
                    return {
                        model: directModel,
                        temperature: defaults.temperature,
                        maxOutputTokens: defaults.maxOutputTokens,
                        providerOptions: filterGatewayOptions(defaults.providerOptions),
                    };
                }
            }
        }
    }
    // 2. OpenRouter fallback
    const openrouterKey = getLocalSecret(ownerId, "llm:openrouter");
    if (openrouterKey) {
        return {
            model: createOpenRouterModel(modelString, openrouterKey),
            temperature: defaults.temperature,
            maxOutputTokens: defaults.maxOutputTokens,
            providerOptions: filterGatewayOptions(defaults.providerOptions),
        };
    }
    // 3. No BYOK — return model string (Stella AI Proxy will resolve it)
    return {
        model: modelString,
        temperature: defaults.temperature,
        maxOutputTokens: defaults.maxOutputTokens,
        providerOptions: defaults.providerOptions,
    };
}
/**
 * Resolve a fallback model config.
 */
export function resolveFallbackConfig(agentType, ownerId) {
    const defaults = getModelConfig(agentType);
    if (!defaults.fallback)
        return null;
    const fallbackModel = defaults.fallback;
    if (!ownerId) {
        return {
            model: fallbackModel,
            temperature: defaults.temperature,
            maxOutputTokens: defaults.maxOutputTokens,
        };
    }
    // Same BYOK chain for fallback model
    const provider = extractProvider(fallbackModel);
    if (provider) {
        const secretKey = providerToSecretKey(provider);
        if (secretKey) {
            const apiKey = getLocalSecret(ownerId, secretKey);
            if (apiKey) {
                const directModel = createProviderModel(fallbackModel, apiKey);
                if (directModel) {
                    return {
                        model: directModel,
                        temperature: defaults.temperature,
                        maxOutputTokens: defaults.maxOutputTokens,
                    };
                }
            }
        }
    }
    const openrouterKey = getLocalSecret(ownerId, "llm:openrouter");
    if (openrouterKey) {
        return {
            model: createOpenRouterModel(fallbackModel, openrouterKey),
            temperature: defaults.temperature,
            maxOutputTokens: defaults.maxOutputTokens,
        };
    }
    return {
        model: fallbackModel,
        temperature: defaults.temperature,
        maxOutputTokens: defaults.maxOutputTokens,
    };
}
