/**
 * Local model resolver — resolves per-agent model config with BYOK support.
 * Reads preferences and secrets from local SQLite instead of Convex.
 *
 * BYOK chain: Direct provider key → OpenRouter → AI Gateway → Stella AI Proxy
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { rawQuery } from "../db.js";
import { getModelConfig } from "./model.js";

export type ResolvedModelConfig = {
  model: string | LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
};

function extractProvider(modelString: string): string | null {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return null;
  return modelString.slice(0, slash);
}

function extractModelName(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return modelString;
  return modelString.slice(slash + 1);
}

function createProviderModel(modelString: string, apiKey: string): LanguageModel | null {
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

function createOpenRouterModel(modelString: string, apiKey: string): LanguageModel {
  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  return openrouter(modelString);
}

function filterGatewayOptions(
  providerOptions?: Record<string, unknown>,
): ProviderOptions | undefined {
  if (!providerOptions) return undefined;
  const { gateway, ...rest } = providerOptions;
  return Object.keys(rest).length > 0 ? (rest as ProviderOptions) : undefined;
}

function providerToSecretKey(provider: string): string | null {
  switch (provider) {
    case "anthropic": return "llm:anthropic";
    case "openai": return "llm:openai";
    case "google": return "llm:google";
    default: return null;
  }
}

/** Get a decrypted secret value from local SQLite */
function getLocalSecret(ownerId: string, provider: string): string | null {
  const rows = rawQuery<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM secrets WHERE owner_id = ? AND provider = ? AND status = 'active' LIMIT 1",
    [ownerId, provider],
  );
  if (rows.length === 0) return null;
  // In local mode, "encrypted_value" is stored in plaintext since it's on the user's device
  return rows[0].encrypted_value;
}

/** Get a preference value from local SQLite */
function getLocalPreference(ownerId: string, key: string): string | null {
  const rows = rawQuery<{ value: string }>(
    "SELECT value FROM user_preferences WHERE owner_id = ? AND key = ?",
    [ownerId, key],
  );
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Resolve the model config for an agent type, applying user overrides and BYOK.
 */
export function resolveModelConfig(
  agentType: string,
  ownerId?: string,
): ResolvedModelConfig {
  const defaults = getModelConfig(agentType);

  if (!ownerId) {
    return {
      model: defaults.model,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as ProviderOptions | undefined,
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
            providerOptions: filterGatewayOptions(defaults.providerOptions as Record<string, unknown>),
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
      providerOptions: filterGatewayOptions(defaults.providerOptions as Record<string, unknown>),
    };
  }

  // 3. No BYOK — return model string (Stella AI Proxy will resolve it)
  return {
    model: modelString,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as ProviderOptions | undefined,
  };
}

/**
 * Resolve a fallback model config.
 */
export function resolveFallbackConfig(
  agentType: string,
  ownerId?: string,
): ResolvedModelConfig | null {
  const defaults = getModelConfig(agentType);
  if (!defaults.fallback) return null;

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
