import { getAllModels } from "../../../../../runtime/ai/models.js";
import type { Api, Model } from "../../../../../runtime/ai/types.js";
// Provider display names live in a shared, browser-safe runtime module so the
// model picker and the runtime route-error toasts can't drift apart.
import { getProviderDisplayName } from "../../../../../runtime/ai/provider-display.js";
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

export { getProviderDisplayName };

/**
 * The curated Stella preset "modes" are a fixed, branded set (mirrors
 * `STELLA_ALIAS_MODES` in backend `stella_models.ts`). They never change at
 * runtime, so the compact picker should render them instantly — offline,
 * pre-auth, or while `/api/models` is still loading — rather than depending on
 * a network round-trip. The fetched catalog only *refines* them (authoritative
 * `allowedForAudience`, resolved upstream model); this is the always-present
 * scaffold. Keep in sync with the backend mode list.
 */
// `upstreamModel` mirrors the backend's per-mode default (`BASE_MODE_CONFIGS`
// in `stella_models.ts`, and the offline `fallbackResolvedModelForAlias` in
// `runtime/kernel/model-routing-stella.ts`). It drives the preset subtitle
// (the underlying model name, e.g. "claude-opus-4.8"), so the compact picker
// shows the same "preset + model" rows before the catalog refines them per
// audience. Keep these in sync with the backend mode list.
const STELLA_PRESET_FALLBACK_DEFS: ReadonlyArray<{
  mode: string;
  name: string;
  upstreamModel: string;
}> = [
  {
    mode: "light",
    name: "Stella Light",
    upstreamModel: "accounts/fireworks/models/deepseek-v4-flash",
  },
  {
    mode: "standard",
    name: "Stella Standard",
    upstreamModel: "openrouter/x-ai/grok-4.5",
  },
  {
    mode: "priority",
    name: "Stella Priority",
    upstreamModel: "accounts/fireworks/models/kimi-k2p7-code",
  },
  { mode: "builder", name: "Stella Builder", upstreamModel: "openai/gpt-5.5" },
  {
    mode: "designer",
    name: "Stella Designer",
    upstreamModel: "anthropic/claude-opus-4.8",
  },
  {
    mode: "vision",
    name: "Stella Vision",
    upstreamModel: "google/gemini-3-flash-preview",
  },
  {
    mode: "max",
    name: "Stella Max",
    upstreamModel: "anthropic/claude-fable-5",
  },
];

export const STELLA_PRESET_FALLBACK_MODELS: readonly CatalogModel[] =
  STELLA_PRESET_FALLBACK_DEFS.map(({ mode, name, upstreamModel }) => ({
    id: `stella/${mode}`,
    modelId: mode,
    name,
    provider: "stella",
    providerName: getProviderDisplayName("stella"),
    source: "stella" as const,
    upstreamModel,
  }));

/**
 * Merge the fixed Stella preset fallbacks under the fetched Stella catalog so
 * the curated modes are always present in the picker; any matching fetched
 * entry (carrying authoritative metadata) overrides its fallback.
 */
export function withStellaPresetFallbacks(
  stellaModels: readonly CatalogModel[],
): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const preset of STELLA_PRESET_FALLBACK_MODELS) {
    byId.set(preset.id, preset);
  }
  for (const model of stellaModels) {
    byId.set(model.id, model);
  }
  return Array.from(byId.values());
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
    .filter(
      (model) =>
        !model.type || model.type === "language" || model.type === "multimodal",
    )
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

const MODELS_DEV_DIRECT_PROVIDER_KEYS = new Set([
  "anthropic",
  "cerebras",
  "google",
  "groq",
  "mistral",
  "moonshotai",
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
