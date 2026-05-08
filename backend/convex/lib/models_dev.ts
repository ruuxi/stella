type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

type ModelsDevModalities = {
  input?: string[];
  output?: string[];
};

type ModelsDevModelEntry = {
  id?: string;
  cost?: ModelsDevCost;
  modalities?: ModelsDevModalities;
  last_updated?: string;
};

type ModelsDevProviderEntry = {
  models?: Record<string, ModelsDevModelEntry>;
};

export type ModelsDevApi = Record<string, ModelsDevProviderEntry>;

export type ManagedModelPriceEntry = {
  model: string;
  source: "models.dev";
  sourceProvider: string;
  sourceModelId: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
  reasoningPerMillionUsd: number;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  sourceUpdatedAt: string;
  syncedAt: number;
};

type ResolvedModelsDevModel = {
  sourceProvider: string;
  sourceModelId: string;
  entry: ModelsDevModelEntry;
};

/**
 * Sibling model fallback for routers/wrappers not directly in models.dev or
 * listed at $0. Used for both pricing and modality lookup so a router that
 * shares a serving model (e.g. Fireworks `kimi-k2p6-turbo` is a faster mode
 * of `kimi-k2p6`) inherits the underlying model's metadata.
 */
const MODELS_DEV_FALLBACKS: Record<string, string> = {
  "accounts/fireworks/routers/kimi-k2p5-turbo":
    "accounts/fireworks/models/kimi-k2p5",
  "accounts/fireworks/routers/kimi-k2p6-turbo":
    "accounts/fireworks/models/kimi-k2p6",
};

const MODELS_DEV_ALIASES: Record<string, string[]> = {
  "google/gemini-3-flash-preview": [
    "google/gemini-3-flash",
    "vercel/google/gemini-3-flash",
    "vercel/google/gemini-3-flash-preview",
  ],
  "anthropic/claude-sonnet-4.6": [
    "vercel/anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4-6",
  ],
  "anthropic/claude-opus-4.7": [
    "vercel/anthropic/claude-opus-4.7",
    "anthropic/claude-opus-4-7",
  ],
  "anthropic/claude-opus-4.6": [
    "vercel/anthropic/claude-opus-4.6",
    "anthropic/claude-opus-4-6",
  ],
  "anthropic/claude-opus-4.5": [
    "vercel/anthropic/claude-opus-4.5",
    "anthropic/claude-opus-4-5",
  ],
};

const parseCandidatePath = (value: string) => {
  const slashIndex = value.indexOf("/");
  if (slashIndex < 0) {
    return null;
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
};

const resolveModelsDevModel = (
  data: ModelsDevApi,
  model: string,
): ResolvedModelsDevModel | null => {
  const direct = parseCandidatePath(model);
  const candidates = [
    `vercel/${model}`,
    model,
    ...(MODELS_DEV_ALIASES[model] ?? []),
  ];

  // models.dev uses provider "fireworks-ai" with full IDs (e.g. accounts/fireworks/routers/…)
  // as keys; a naive split on the first "/" looks under data.accounts instead.
  if (model.startsWith("accounts/fireworks/")) {
    candidates.push(`fireworks-ai/${model}`);
  }

  if (direct) {
    candidates.push(`${direct.provider}/${direct.modelId.replace(/\./g, "-")}`);
    if (direct.provider === "accounts" && direct.modelId.startsWith("fireworks/models/")) {
      candidates.push(`fireworks/${direct.modelId.slice("fireworks/models/".length)}`);
    }
  }

  for (const candidate of candidates) {
    const parsed = parseCandidatePath(candidate);
    if (!parsed) {
      continue;
    }

    const entry = data[parsed.provider]?.models?.[parsed.modelId];
    if (!entry) {
      continue;
    }

    return {
      sourceProvider: parsed.provider,
      sourceModelId: parsed.modelId,
      entry,
    };
  }

  return null;
};

const resolveWithFallback = (
  data: ModelsDevApi,
  model: string,
): ResolvedModelsDevModel | null => {
  const direct = resolveModelsDevModel(data, model);
  const fallbackId = MODELS_DEV_FALLBACKS[model];
  if (!direct) {
    if (fallbackId) {
      return resolveModelsDevModel(data, fallbackId);
    }
    return null;
  }
  return direct;
};

const toNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const sanitizeModalityList = (modalities?: string[]): string[] => {
  if (!Array.isArray(modalities)) return ["text"];
  const sanitized = modalities.filter(
    (item): item is string =>
      typeof item === "string" && item.length > 0 && item.length < 32,
  );
  return sanitized.length > 0 ? sanitized : ["text"];
};

export const buildManagedModelPriceEntries = (args: {
  data: ModelsDevApi;
  modelIds: string[];
  syncedAt: number;
}) => {
  const entries: ManagedModelPriceEntry[] = [];
  const missingModels: string[] = [];

  for (const model of args.modelIds) {
    const resolved = resolveWithFallback(args.data, model);
    if (!resolved) {
      missingModels.push(model);
      continue;
    }

    // Pricing fallback: if the resolved entry exists but lists $0 input/output
    // (typically routers/wrappers that defer pricing to a sibling model),
    // re-resolve using the fallback id for pricing only. Modalities still
    // come from `resolved` (or its own fallback) since they're not affected
    // by the $0-pricing pattern.
    let costEntry = resolved.entry;
    const fallbackId = MODELS_DEV_FALLBACKS[model];
    if (
      fallbackId
      && toNumber(resolved.entry.cost?.input) === 0
      && toNumber(resolved.entry.cost?.output) === 0
    ) {
      const fallbackResolved = resolveModelsDevModel(args.data, fallbackId);
      if (fallbackResolved?.entry.cost) {
        costEntry = fallbackResolved.entry;
      }
    }

    entries.push({
      model,
      source: "models.dev",
      sourceProvider: resolved.sourceProvider,
      sourceModelId: resolved.sourceModelId,
      inputPerMillionUsd: toNumber(costEntry.cost?.input),
      outputPerMillionUsd: toNumber(costEntry.cost?.output),
      cacheReadPerMillionUsd: toNumber(costEntry.cost?.cache_read),
      cacheWritePerMillionUsd: toNumber(costEntry.cost?.cache_write),
      reasoningPerMillionUsd: toNumber(costEntry.cost?.reasoning),
      modalitiesInput: sanitizeModalityList(resolved.entry.modalities?.input),
      modalitiesOutput: sanitizeModalityList(resolved.entry.modalities?.output),
      sourceUpdatedAt: resolved.entry.last_updated?.trim() ?? "",
      syncedAt: args.syncedAt,
    });
  }

  return {
    entries,
    missingModels,
  };
};
