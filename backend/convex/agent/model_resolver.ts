/**
 * Model resolver — resolves per-agent model config with user overrides and BYOK support.
 *
 * Flow:
 * 1. Start with getModelConfig(agentType) defaults
 * 2. If ownerId provided, check user_preferences for model_config:{agentType} override
 * 3. If override found, replace model string
 * 4. If ownerId provided, check secrets for llm:{provider} API key
 * 5. If user key found, create direct provider model instance (bypass gateway)
 * 6. If no user key, return model string as-is (gateway resolves it)
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getModelConfig } from "./model";

type ResolvedModelConfig = {
  model: string | LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
};

/** Extract provider prefix from a model string like "anthropic/claude-opus-4.6" */
function extractProvider(modelString: string): string | null {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return null;
  return modelString.slice(0, slash);
}

/** Extract model name after provider prefix */
function extractModelName(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return modelString;
  return modelString.slice(slash + 1);
}

/** Create a direct provider model instance for BYOK */
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

/** Map provider prefix to secrets provider key */
function providerToSecretKey(provider: string): string | null {
  switch (provider) {
    case "anthropic":
      return "llm:anthropic";
    case "openai":
      return "llm:openai";
    case "google":
      return "llm:google";
    default:
      return null;
  }
}

/**
 * Resolve the model config for an agent type, applying user overrides and BYOK.
 *
 * - If no ownerId is provided, returns the default config (same as getModelConfig).
 * - If ownerId is provided, checks for a user model override preference.
 * - If the model's provider has a user-supplied API key, creates a direct provider instance.
 */
export async function resolveModelConfig(
  ctx: { runQuery: ActionCtx["runQuery"] },
  agentType: string,
  ownerId?: string,
): Promise<ResolvedModelConfig> {
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
  const override = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
    ownerId,
    key: `model_config:${agentType}`,
  });
  if (override) {
    modelString = override;
  }

  // Check for BYOK — look up user's API key for this model's provider
  const provider = extractProvider(modelString);
  if (provider) {
    const secretKey = providerToSecretKey(provider);
    if (secretKey) {
      const apiKey = await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
        ownerId,
        provider: secretKey,
      });
      if (apiKey) {
        const directModel = createProviderModel(modelString, apiKey);
        if (directModel) {
          return {
            model: directModel,
            temperature: defaults.temperature,
            maxOutputTokens: defaults.maxOutputTokens,
            // Don't pass gateway providerOptions when using direct provider
          };
        }
      }
    }
  }

  // No BYOK — return model string (gateway will resolve it)
  return {
    model: modelString,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as ProviderOptions | undefined,
  };
}
