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
import { createGateway, type LanguageModel } from "ai";
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

/** Create a model via OpenRouter (OpenAI-compatible API, any provider/model) */
function createOpenRouterModel(modelString: string, apiKey: string): LanguageModel {
  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  // OpenRouter accepts full provider/model strings as the model ID
  return openrouter(modelString);
}

/** Create a model via Vercel AI Gateway with user's own key */
function createGatewayModel(modelString: string, apiKey: string): LanguageModel {
  const gateway = createGateway({ apiKey });
  return gateway(modelString);
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

/** Helper to look up a user's decrypted key for a given provider */
async function getUserKey(
  ctx: { runQuery: ActionCtx["runQuery"] },
  ownerId: string,
  provider: string,
): Promise<string | null> {
  return await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
    ownerId,
    provider,
  });
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

  // BYOK fallback chain:
  // 1. Direct provider key (anthropic, openai, google)
  // 2. OpenRouter key (routes any model through OpenRouter)
  // 3. Vercel AI Gateway key (user's own gateway key)
  // 4. Platform gateway (default, no user key)
  const provider = extractProvider(modelString);

  // 1. Direct provider key
  if (provider) {
    const secretKey = providerToSecretKey(provider);
    if (secretKey) {
      const apiKey = await getUserKey(ctx, ownerId, secretKey);
      if (apiKey) {
        const directModel = createProviderModel(modelString, apiKey);
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

  // 2. OpenRouter fallback
  const openrouterKey = await getUserKey(ctx, ownerId, "llm:openrouter");
  if (openrouterKey) {
    return {
      model: createOpenRouterModel(modelString, openrouterKey),
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
    };
  }

  // 3. User's own Vercel AI Gateway key
  const gatewayKey = await getUserKey(ctx, ownerId, "llm:gateway");
  if (gatewayKey) {
    return {
      model: createGatewayModel(modelString, gatewayKey),
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
    };
  }

  // 4. No BYOK — return model string (platform gateway will resolve it)
  return {
    model: modelString,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as ProviderOptions | undefined,
  };
}
