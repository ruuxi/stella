/**
 * Model resolver — resolves backend model config with user model overrides.
 *
 * Backend execution is Stella-managed. Local/runtime BYOK happens in the
 * desktop runtime, not here.
 */

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getModelConfig } from "./model";
import { resolveStellaModelSelection } from "../stella_models";

export type ResolvedModelConfig = {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
};

/**
 * Resolve the model config for an agent type, applying user model overrides.
 *
 * - If no ownerId is provided, returns the default config (same as getModelConfig).
 * - If ownerId is provided, checks for a user model override preference.
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
    modelString = resolveStellaModelSelection(agentType, override);
  }

  return {
    model: modelString,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as ProviderOptions | undefined,
  };
}

/**
 * Resolve a fallback model config for an agent type.
 *
 * Returns null if the agent has no fallback configured.
 * Uses the same managed resolution as resolveModelConfig but with the fallback model string.
 * Temperature and maxOutputTokens are inherited from the primary config.
 */
export async function resolveFallbackConfig(
  ctx: { runQuery: ActionCtx["runQuery"] },
  agentType: string,
  ownerId?: string,
): Promise<ResolvedModelConfig | null> {
  const defaults = getModelConfig(agentType);
  if (!defaults.fallback) return null;

  const fallbackModel = defaults.fallback;

  if (!ownerId) {
    return {
      model: fallbackModel,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as ProviderOptions | undefined,
    };
  }

  return {
    model: fallbackModel,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as ProviderOptions | undefined,
  };
}
