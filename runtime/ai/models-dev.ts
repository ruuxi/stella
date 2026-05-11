import { getModels, registerModel } from "./models.js";
import type { Api, Model } from "./types.js";

type ModelsDevModelEntry = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
};

type ModelsDevProviderEntry = {
  models?: Record<string, ModelsDevModelEntry>;
};

type ModelsDevApi = Record<string, ModelsDevProviderEntry>;

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 3_000;

const MODELS_DEV_DIRECT_PROVIDER_KEYS = new Set([
  "anthropic",
  "cerebras",
  "google",
  "groq",
  "mistral",
  "moonshotai",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

const REGISTRY_PROVIDER_BY_MODELS_DEV_PROVIDER: Record<string, string> = {
  moonshotai: "kimi-coding",
};

const toRegistryProvider = (provider: string): string =>
  REGISTRY_PROVIDER_BY_MODELS_DEV_PROVIDER[provider] ?? provider;

const toModelInput = (
  input: readonly string[] | undefined,
): Model<Api>["input"] => {
  const next: Model<Api>["input"] = ["text"];
  if (input?.includes("image")) {
    next.push("image");
  }
  return next;
};

const hasTextInAndOut = (entry: ModelsDevModelEntry): boolean => {
  const input = entry.modalities?.input ?? ["text"];
  const output = entry.modalities?.output ?? ["text"];
  return input.includes("text") && output.includes("text");
};

const cloneModelsDevModel = (
  template: Model<Api>,
  modelId: string,
  entry: ModelsDevModelEntry,
): Model<Api> => ({
  ...template,
  id: modelId,
  name: entry.name?.trim() || modelId,
  reasoning: entry.reasoning ?? template.reasoning,
  input: toModelInput(entry.modalities?.input),
  cost: {
    input: entry.cost?.input ?? template.cost.input,
    output: entry.cost?.output ?? template.cost.output,
    cacheRead: entry.cost?.cache_read ?? template.cost.cacheRead,
    cacheWrite: entry.cost?.cache_write ?? template.cost.cacheWrite,
  },
  contextWindow: entry.limit?.context ?? template.contextWindow,
  maxTokens: entry.limit?.output ?? template.maxTokens,
});

export function registerModelsDevDirectProviderModels(
  data: ModelsDevApi,
): number {
  let registered = 0;
  for (const [modelsDevProvider, providerEntry] of Object.entries(data)) {
    if (!MODELS_DEV_DIRECT_PROVIDER_KEYS.has(modelsDevProvider)) continue;
    const registryProvider = toRegistryProvider(modelsDevProvider);
    const registryModels = getModels(registryProvider as never) as Model<Api>[];
    const template = registryModels[0];
    if (!template) continue;
    const existing = new Set(registryModels.map((model) => model.id));
    for (const [key, entry] of Object.entries(providerEntry.models ?? {})) {
      const modelId = (entry.id ?? key).trim();
      if (!modelId || existing.has(modelId) || !hasTextInAndOut(entry)) {
        continue;
      }
      registerModel(
        registryProvider,
        cloneModelsDevModel(template, modelId, entry),
      );
      existing.add(modelId);
      registered += 1;
    }
  }
  return registered;
}

export async function fetchAndRegisterModelsDevDirectProviderModels(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT_MS);
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`models.dev returned HTTP ${response.status}`);
    }
    const data = (await response.json()) as ModelsDevApi;
    return registerModelsDevDirectProviderModels(data);
  } finally {
    clearTimeout(timeout);
  }
}
