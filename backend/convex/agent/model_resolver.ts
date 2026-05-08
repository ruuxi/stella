/**
 * Model resolver - resolves backend managed model config.
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
  /**
   * Input modalities resolved from `billing_model_prices` (synced from
   * models.dev). Forwarded to `buildManagedModel` so unsupported parts
   * (image/audio/video/pdf) are dropped at the gateway boundary instead of
   * being shipped to providers that may tokenize the data URLs as raw
   * characters. Defaults to ["text"] when the row is missing or
   * unpopulated.
   */
  modalitiesInput?: ("text" | "image" | "audio" | "video" | "pdf")[];
};

const TEXT_ONLY: ("text" | "image" | "audio" | "video" | "pdf")[] = ["text"];

const KNOWN_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

const sanitizeStoredModalities = (
  modalities: readonly string[] | undefined,
): ("text" | "image" | "audio" | "video" | "pdf")[] => {
  if (!modalities || modalities.length === 0) return TEXT_ONLY;
  const filtered = modalities.filter(
    (m): m is "text" | "image" | "audio" | "video" | "pdf" =>
      KNOWN_MODALITIES.has(m),
  );
  return filtered.length > 0 ? filtered : TEXT_ONLY;
};

type RunQueryCtx = { runQuery: ActionCtx["runQuery"] };

const lookupModalitiesInput = async (
  ctx: RunQueryCtx,
  model: string,
): Promise<("text" | "image" | "audio" | "video" | "pdf")[]> => {
  const row = await ctx.runQuery(internal.billing.getManagedModelPrice, {
    model,
  });
  if (!row) return TEXT_ONLY;
  return sanitizeStoredModalities(row.modalitiesInput);
};

export const toResolvedModelConfig = (
  config: {
    model: string;
    managedGatewayProvider?: ManagedGatewayProvider;
    temperature?: number;
    maxOutputTokens?: number;
    providerOptions?: unknown;
  },
  modalitiesInput?: ResolvedModelConfig["modalitiesInput"],
): ResolvedModelConfig => ({
  model: config.model,
  managedGatewayProvider: resolveManagedGatewayProvider({
    model: config.model,
    configuredProvider: config.managedGatewayProvider,
  }),
  temperature: config.temperature,
  maxOutputTokens: config.maxOutputTokens,
  providerOptions: config.providerOptions as Record<string, Record<string, unknown>> | undefined,
  modalitiesInput,
});

type ResolveModelConfigOptions = {
  audience?: ManagedModelAudience;
  access?: ManagedModelAccess;
};

export async function resolveModelConfig(
  ctx: RunQueryCtx,
  agentType: string,
  ownerId?: string,
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig> {
  const audience = options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);
  const modalitiesInput = await lookupModalitiesInput(ctx, defaults.model);
  void ownerId;
  return toResolvedModelConfig(defaults, modalitiesInput);
}

export async function resolveFallbackConfig(
  ctx: RunQueryCtx,
  agentType: string,
  ownerId?: string,
  options?: ResolveModelConfigOptions,
): Promise<ResolvedModelConfig | null> {
  const audience = options?.access?.modelAudience ?? options?.audience ?? "free";
  const defaults = getModelConfig(agentType, audience);
  if (!defaults.fallback) return null;
  const modalitiesInput = await lookupModalitiesInput(ctx, defaults.fallback);

  const resolvedFallback = toResolvedModelConfig(
    {
      model: defaults.fallback,
      managedGatewayProvider: defaults.fallbackManagedGatewayProvider,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.fallbackProviderOptions,
    },
    modalitiesInput,
  );

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
