/**
 * Model resolver - resolves backend model config with user model overrides.
 *
 * Backend execution is Stella-managed. Local/runtime BYOK happens in the
 * desktop runtime, not here.
 */

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  getModelConfig,
  type ManagedModelAudience,
} from "./model";
import { resolveManagedGatewayProvider, type ManagedGatewayProvider } from "../lib/managed_gateway";
import { resolveStellaModelSelection } from "../stella_models";
import type { ManagedModelAccess } from "../lib/managed_billing";

export type ResolvedModelConfig = {
  model: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
};

type ResolveModelConfigOptions = {
  audience?: ManagedModelAudience;
  access?: ManagedModelAccess;
};

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
      managedGatewayProvider: defaults.managedGatewayProvider,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
    };
  }

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
    managedGatewayProvider: resolveManagedGatewayProvider({
      model: modelString,
      configuredProvider: defaults.managedGatewayProvider,
    }),
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.providerOptions as Record<string, Record<string, unknown>> | undefined,
  };
}

export async function resolveFallbackConfig(
  ctx: { runQuery: ActionCtx["runQuery"] },
  agentType: string,
  ownerId?: string,
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig | null> {
  const audience = options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);
  if (!defaults.fallback) return null;

  const resolvedFallback: ResolvedModelConfig = {
    model: defaults.fallback,
    managedGatewayProvider: resolveManagedGatewayProvider({
      model: defaults.fallback,
      configuredProvider: defaults.fallbackManagedGatewayProvider,
    }),
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.fallbackProviderOptions as Record<string, Record<string, unknown>> | undefined,
  };

  void ctx;
  void ownerId;
  return resolvedFallback;
}
