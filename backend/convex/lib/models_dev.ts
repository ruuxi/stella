type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

type ModelsDevModelEntry = {
  id?: string;
  cost?: ModelsDevCost;
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
  sourceUpdatedAt: string;
  syncedAt: number;
};

type ResolvedModelsDevModel = {
  sourceProvider: string;
  sourceModelId: string;
  entry: ModelsDevModelEntry;
};

const MODELS_DEV_ALIASES: Record<string, string[]> = {
  "google/gemini-3-flash": [
    "vercel/google/gemini-3-flash",
    "google/gemini-3-flash-preview",
    "vercel/google/gemini-3-flash-preview",
  ],
  "anthropic/claude-sonnet-4.6": [
    "vercel/anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4-6",
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

  if (direct) {
    candidates.push(`${direct.provider}/${direct.modelId.replace(/\./g, "-")}`);
  }

  for (const candidate of candidates) {
    const parsed = parseCandidatePath(candidate);
    if (!parsed) {
      continue;
    }

    const entry = data[parsed.provider]?.models?.[parsed.modelId];
    if (!entry?.cost) {
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

const toNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const buildManagedModelPriceEntries = (args: {
  data: ModelsDevApi;
  modelIds: string[];
  syncedAt: number;
}) => {
  const entries: ManagedModelPriceEntry[] = [];
  const missingModels: string[] = [];

  for (const model of args.modelIds) {
    const resolved = resolveModelsDevModel(args.data, model);
    if (!resolved) {
      missingModels.push(model);
      continue;
    }

    entries.push({
      model,
      source: "models.dev",
      sourceProvider: resolved.sourceProvider,
      sourceModelId: resolved.sourceModelId,
      inputPerMillionUsd: toNumber(resolved.entry.cost?.input),
      outputPerMillionUsd: toNumber(resolved.entry.cost?.output),
      cacheReadPerMillionUsd: toNumber(resolved.entry.cost?.cache_read),
      cacheWritePerMillionUsd: toNumber(resolved.entry.cost?.cache_write),
      reasoningPerMillionUsd: toNumber(resolved.entry.cost?.reasoning),
      sourceUpdatedAt: resolved.entry.last_updated?.trim() ?? "",
      syncedAt: args.syncedAt,
    });
  }

  return {
    entries,
    missingModels,
  };
};
