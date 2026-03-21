/**
 * Model resolver — resolves backend model config with user model overrides.
 *
 * Backend execution is Stella-managed. Local/runtime BYOK happens in the
 * desktop runtime, not here.
 */

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getModelConfig, type ManagedModelAudience } from "./model";
import { resolveStellaModelSelection } from "../stella_models";
import type { ManagedModelAccess } from "../lib/managed_billing";

export type ResolvedModelConfig = {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
};

type ResolveModelConfigOptions = {
  audience?: ManagedModelAudience;
  access?: ManagedModelAccess;
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
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig> {
  const audience = options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);

  if (!ownerId) {
    return {
      model: defaults.model,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
    };
  }

  // Check for user model override
  let modelString = defaults.model;
  const override = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
    ownerId,
    key: `model_config:${agentType}`,
  });
  if (override) {
    modelString = resolveStellaModelSelection(agentType, override, audience);
  }

  return {
    model: modelString,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
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
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig | null> {
  const audience = options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);
  if (!defaults.fallback) return null;

  const fallbackModel = defaults.fallback;

  if (!ownerId) {
    return {
      model: fallbackModel,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
    };
  }

  return {
    model: fallbackModel,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
  };
}
