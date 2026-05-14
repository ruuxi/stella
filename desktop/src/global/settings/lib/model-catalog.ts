import { getAllModels } from "../../../../../runtime/ai/models.js";
import type { Api, Model } from "../../../../../runtime/ai/types.js";
import { LOCAL_MODEL_PROVIDER_KEYS } from "./llm-providers";

export type CatalogModelSource = "stella" | "local";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  modelId: string;
  source: CatalogModelSource;
  upstreamModel?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Model<Api>["input"];
  reasoning?: boolean;
  /**
   * Whether the backend will honor this model for the current user's
   * audience. Defaults to true; the Stella `/api/models` endpoint sets
   * it to false on per-tier-restricted models so the picker disables
   * them in sync with the backend's request-time coercion. Models from
   * other providers (BYOK / local) never carry a restriction.
   */
  allowedForAudience?: boolean;
};

export type CatalogDefaultModel = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

export type ProviderGroup = {
  provider: string;
  providerName: string;
  models: CatalogModel[];
};

export type CatalogApiModel = {
  id: string;
  name?: string;
  provider?: string;
  type?: string;
  upstreamModel?: string;
  allowedForAudience?: boolean;
};

export type CatalogApiResponse = {
  data?: CatalogApiModel[];
  defaults?: CatalogDefaultModel[];
};

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

export type ModelsDevApi = Record<string, ModelsDevProviderEntry>;

const PROVIDER_NAMES: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  cerebras: "Cerebras",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-antigravity": "Google Antigravity",
  "google-gemini-cli": "Google Gemini CLI",
  "google-vertex": "Google Vertex",
  groq: "Groq",
  huggingface: "Hugging Face",
  local: "Local",
  "kimi-coding": "Kimi",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  mistral: "Mistral",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  stella: "Stella",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  zai: "Z.AI",
};

export function getProviderDisplayName(provider: string): string {
  const normalized = provider.trim();
  const mapped = PROVIDER_NAMES[normalized];
  if (mapped) return mapped;
  return normalized
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  if (a.provider === "stella" && b.provider !== "stella") return -1;
  if (a.provider !== "stella" && b.provider === "stella") return 1;
  const providerSort = a.providerName.localeCompare(b.providerName);
  if (providerSort) return providerSort;
  const aIsStellaPreset =
    a.provider === "stella" &&
    (a.name.startsWith("Stella ") ||
      (a.id.startsWith("stella/") && !a.modelId.includes("/")));
  const bIsStellaPreset =
    b.provider === "stella" &&
    (b.name.startsWith("Stella ") ||
      (b.id.startsWith("stella/") && !b.modelId.includes("/")));
  if (aIsStellaPreset && !bIsStellaPreset) return -1;
  if (!aIsStellaPreset && bIsStellaPreset) return 1;
  if (a.source === "stella" && b.source !== "stella") return -1;
  if (a.source !== "stella" && b.source === "stella") return 1;
  return a.name.localeCompare(b.name);
}

function toDirectModelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export function listLocalCatalogModels(): CatalogModel[] {
  const localUrlModels: CatalogModel[] = [
    {
      id: "local/llama3.2",
      modelId: "llama3.2",
      name: "llama3.2",
      provider: "local",
      providerName: getProviderDisplayName("local"),
      source: "local",
      input: ["text"],
      reasoning: false,
    },
  ];

  return [
    ...localUrlModels,
    ...getAllModels()
      .filter(
        (model) =>
          model.api !== "stella" &&
          LOCAL_MODEL_PROVIDER_KEYS.has(model.provider),
      )
      .map((model) => ({
        id: toDirectModelId(model),
        modelId: model.id,
        name: model.name || model.id,
        provider: model.provider,
        providerName: getProviderDisplayName(model.provider),
        source: "local" as const,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        reasoning: model.reasoning,
      })),
  ].sort((a, b) => {
    const providerSort = a.providerName.localeCompare(b.providerName);
    return providerSort || a.name.localeCompare(b.name);
  });
}

export function normalizeStellaCatalogModels(
  models: readonly CatalogApiModel[],
): CatalogModel[] {
  return models
    .filter((model) => !model.type || model.type === "language")
    .map((model) => {
      const provider = model.provider ?? "stella";
      return {
        id: model.id,
        modelId: model.id.startsWith(`${provider}/`)
          ? model.id.slice(provider.length + 1)
          : model.id,
        name: model.name ?? model.id,
        provider,
        providerName: getProviderDisplayName(provider),
        upstreamModel: model.upstreamModel,
        allowedForAudience: model.allowedForAudience,
        source: "stella" as const,
      };
    });
}

const MANAGED_GATEWAY_MODEL_SOURCES = [
  {
    provider: "fireworks-ai",
  },
  {
    provider: "openrouter",
  },
] as const;

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

function toCatalogInput(
  input: readonly string[] | undefined,
): Model<Api>["input"] {
  const next: Model<Api>["input"] = ["text"];
  if (input?.includes("image")) {
    next.push("image");
  }
  return next;
}

export function normalizeManagedGatewayCatalogModels(
  data: ModelsDevApi,
): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const source of MANAGED_GATEWAY_MODEL_SOURCES) {
    const sourceModels = data[source.provider]?.models ?? {};
    for (const [modelId, entry] of Object.entries(sourceModels)) {
      const upstreamModel = (entry.id ?? modelId).trim();
      if (!upstreamModel) continue;
      models.push({
        id: `stella/${upstreamModel}`,
        modelId: upstreamModel,
        name: entry.name?.trim() || getProviderDisplayName(upstreamModel),
        provider: "stella",
        providerName: getProviderDisplayName("stella"),
        source: "stella",
        upstreamModel,
      });
    }
  }
  return models.sort(compareCatalogModels);
}

export function normalizeDirectProviderCatalogModels(
  data: ModelsDevApi,
): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const [provider, providerEntry] of Object.entries(data)) {
    if (!MODELS_DEV_DIRECT_PROVIDER_KEYS.has(provider)) continue;
    const sourceModels = providerEntry.models ?? {};
    for (const [modelId, entry] of Object.entries(sourceModels)) {
      const id = (entry.id ?? modelId).trim();
      if (!id) continue;
      const input = entry.modalities?.input ?? ["text"];
      const output = entry.modalities?.output ?? ["text"];
      if (!input.includes("text") || !output.includes("text")) continue;
      models.push({
        id: `${provider}/${id}`,
        modelId: id,
        name: entry.name?.trim() || id,
        provider,
        providerName: getProviderDisplayName(provider),
        source: "local",
        contextWindow: entry.limit?.context,
        maxTokens: entry.limit?.output,
        input: toCatalogInput(input),
        reasoning: entry.reasoning ?? false,
      });
    }
  }
  return models.sort(compareCatalogModels);
}

export function mergeCatalogModels(
  stellaModels: readonly CatalogModel[],
  localModels: readonly CatalogModel[],
): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const model of localModels) {
    byId.set(model.id, model);
  }
  for (const model of stellaModels) {
    byId.set(model.id, model);
  }
  return Array.from(byId.values()).sort(compareCatalogModels);
}

export function groupCatalogModelsByProvider(
  models: readonly CatalogModel[],
): ProviderGroup[] {
  const map = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return Array.from(map.entries())
    .map(([provider, models]) => ({
      provider,
      providerName: models[0]?.providerName ?? getProviderDisplayName(provider),
      models: [...models].sort(compareCatalogModels),
    }))
    .sort((a, b) => {
      if (a.provider === "stella" && b.provider !== "stella") return -1;
      if (a.provider !== "stella" && b.provider === "stella") return 1;
      return a.providerName.localeCompare(b.providerName);
    });
}

/**
 * Strip provider prefixes from a Stella model identifier so the visible
 * label is just the trailing model slug (e.g. `openai/gpt-5` → `gpt-5`,
 * `accounts/fireworks/models/qwen-coder-32b` → `qwen-coder-32b`). For
 * preset Stella models with no slash in the modelId we keep the
 * pre-formatted display name (e.g. "Stella Designer") because that's already
 * the friendly form. Only applied to Stella models — every other provider
 * keeps its standard label.
 */
export function getStellaDisplayName(model: CatalogModel): string {
  if (model.provider !== "stella") return model.name;
  if (!model.name.includes("/")) return model.name;
  const lastSlash = model.name.lastIndexOf("/");
  const tail = model.name.slice(lastSlash + 1).trim();
  return tail || model.name;
}

/**
 * For Stella preset modes ("Stella Designer", "Stella Builder", …) returns the
 * resolved upstream model id with provider prefixes stripped, so users
 * see *both* the friendly preset label and the actual model it currently
 * maps to. Returns null when there's no useful subtitle (e.g. for non-
 * Stella models, or when the upstream slug equals the display name).
 */
export function getStellaSubtitle(model: CatalogModel): string | null {
  if (model.provider !== "stella") return null;
  const candidate = model.upstreamModel?.trim();
  if (!candidate) return null;
  const trimmed = candidate.startsWith("accounts/fireworks/models/")
    ? candidate.slice("accounts/fireworks/models/".length)
    : candidate.startsWith("accounts/fireworks/routers/")
      ? candidate.slice("accounts/fireworks/routers/".length)
      : candidate;
  const lastSlash = trimmed.lastIndexOf("/");
  const tail = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed).trim();
  if (!tail) return null;
  if (tail.toLowerCase() === model.name.toLowerCase()) return null;
  return tail;
}

export function searchCatalogModels(
  models: readonly CatalogModel[],
  query: string,
): CatalogModel[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...models];

  return models.filter((model) => {
    const haystack = [
      model.name,
      model.id,
      model.modelId,
      model.provider,
      model.providerName,
      model.upstreamModel,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}
