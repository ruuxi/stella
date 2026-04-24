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
import {
  assertManagedUsageAllowed,
  type ManagedModelAccess,
} from "../lib/managed_billing";

export type ResolvedModelConfig = {
  model: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
};

export const toResolvedModelConfig = (
  config: {
    model: string;
    managedGatewayProvider?: ManagedGatewayProvider;
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: unknown;
  },
): ResolvedModelConfig => ({
  model: config.model,
  managedGatewayProvider: resolveManagedGatewayProvider({
    model: config.model,
    configuredProvider: config.managedGatewayProvider,
  }),
  temperature: config.temperature,
  maxOutputTokens: config.maxOutputTokens,
  providerOptions: config.providerOptions as Record<string, Record<string, unknown>> | undefined,
});

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
    return toResolvedModelConfig(defaults);
  }

  let modelString = defaults.model;
  const override = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
    ownerId,
    key: `model_config:${agentType}`,
  });
  if (override) {
    modelString = resolveStellaModelSelection(agentType, override, audience);
  }

  return toResolvedModelConfig({
    ...defaults,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    model: modelString,
  });
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

  const resolvedFallback = toResolvedModelConfig({
    model: defaults.fallback,
    managedGatewayProvider: defaults.fallbackManagedGatewayProvider,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: defaults.fallbackProviderOptions,
  });

  void ctx;
  void ownerId;
  return resolvedFallback;
}

export async function resolveManagedModelConfigs(
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  agentType: string,
  ownerId: string,
): Promise<{
  access: ManagedModelAccess;
  config: ResolvedModelConfig;
  fallbackConfig: ResolvedModelConfig | null;
}> {
  const access = await assertManagedUsageAllowed(ctx, ownerId);
  const config = await resolveModelConfig(ctx, agentType, ownerId, { access });
  const fallbackConfig = await resolveFallbackConfig(ctx, agentType, ownerId, { access });
  return { access, config, fallbackConfig };
}
