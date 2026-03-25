import {
  AGENT_MODELS,
  getModeConfig,
  getModelConfig,
  isModelMode,
  listManagedModelIds,
  type ManagedModelAudience,
  type ModelMode,
} from "./agent/model";

export const STELLA_PROVIDER = "stella";
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;
export const STELLA_CHEAP_MODEL = `${STELLA_PROVIDER}/cheap`;
export const STELLA_FAST_MODEL = `${STELLA_PROVIDER}/fast`;
export const STELLA_SMART_MODEL = `${STELLA_PROVIDER}/smart`;
export const STELLA_BEST_MODEL = `${STELLA_PROVIDER}/best`;
export const STELLA_MEDIA_MODEL = `${STELLA_PROVIDER}/media`;

export type StellaCatalogModel = {
  id: string;
  name: string;
  provider: typeof STELLA_PROVIDER;
  upstreamModel: string;
  type: "language" | "multimodal";
};

export type StellaDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "inception/mercury-2": "Mercury 2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "openai/gpt-5.4": "GPT-5.4",
  "openai/gpt-5.4-mini": "GPT-5.4 Mini",
  "zai/glm-4.7": "GLM 4.7",
};

const titleCase = (value: string): string =>
  value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const deriveDisplayName = (upstreamModel: string): string => {
  const mapped = DISPLAY_NAMES[upstreamModel];
  if (mapped) return mapped;

  const slash = upstreamModel.indexOf("/");
  const rawId = slash >= 0 ? upstreamModel.slice(slash + 1) : upstreamModel;
  return titleCase(rawId);
};

const STELLA_ALIAS_MODES = [
  {
    id: STELLA_CHEAP_MODEL,
    name: "Stella Cheap",
    mode: "cheap",
    type: "language" as const,
  },
  {
    id: STELLA_FAST_MODEL,
    name: "Stella Fast",
    mode: "fast",
    type: "language" as const,
  },
  {
    id: STELLA_SMART_MODEL,
    name: "Stella Smart",
    mode: "smart",
    type: "language" as const,
  },
  {
    id: STELLA_BEST_MODEL,
    name: "Stella Best",
    mode: "best",
    type: "language" as const,
  },
  {
    id: STELLA_MEDIA_MODEL,
    name: "Stella Media",
    mode: "media",
    type: "multimodal" as const,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  mode: ModelMode;
  type: "language" | "multimodal";
}>;

const getStaticStellaAliases = (audience: ManagedModelAudience = "free") =>
  STELLA_ALIAS_MODES.map((alias) => ({
    ...alias,
    upstreamModel: getModeConfig(alias.mode, audience).model,
  }));

const listUpstreamManagedModels = (): string[] => {
  return listManagedModelIds().sort((a, b) => deriveDisplayName(a).localeCompare(deriveDisplayName(b)));
};

export const toStellaModelId = (upstreamModel: string): string =>
  `${STELLA_PROVIDER}/${upstreamModel.trim()}`;

export const isStellaModel = (model: string | null | undefined): boolean => {
  const trimmed = model?.trim();
  return Boolean(trimmed) && (trimmed === STELLA_DEFAULT_MODEL || trimmed!.startsWith(`${STELLA_PROVIDER}/`));
};

export const resolveStellaModelSelection = (
  agentType: string,
  selection?: string | null,
  audience: ManagedModelAudience = "free",
): string => {
  const trimmed = selection?.trim();
  if (!trimmed || trimmed === STELLA_DEFAULT_MODEL) {
    return getModelConfig(agentType, audience).model;
  }

  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return trimmed;
  }

  const aliasOrUpstreamModel = trimmed.slice(`${STELLA_PROVIDER}/`.length).trim();
  if (!aliasOrUpstreamModel || aliasOrUpstreamModel === "default") {
    return getModelConfig(agentType, audience).model;
  }

  if (isModelMode(aliasOrUpstreamModel)) {
    return getModeConfig(aliasOrUpstreamModel, audience).model;
  }

  return aliasOrUpstreamModel;
};

export const listStellaCatalogModels = (
  audience: ManagedModelAudience = "free",
): StellaCatalogModel[] => [
  {
    id: STELLA_DEFAULT_MODEL,
    name: "Stella Recommended",
    provider: "stella",
    upstreamModel: "",
    type: "language",
  },
  ...getStaticStellaAliases(audience).map<StellaCatalogModel>((alias) => ({
    id: alias.id,
    name: alias.name,
    provider: STELLA_PROVIDER,
    upstreamModel: alias.upstreamModel,
    type: alias.type,
  })),
  ...listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => ({
    id: toStellaModelId(upstreamModel),
    name: deriveDisplayName(upstreamModel),
    provider: STELLA_PROVIDER,
    upstreamModel,
    type: "language",
  })),
];

export const listStellaDefaultSelections = (
  audience: ManagedModelAudience = "free",
): StellaDefaultEntry[] =>
  Object.keys(AGENT_MODELS).map((agentType) => ({
    agentType,
    model: STELLA_DEFAULT_MODEL,
    resolvedModel: getModelConfig(agentType, audience).model,
  }));
