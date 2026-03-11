import { AGENT_MODELS, DEFAULT_MODEL, getModelConfig } from "./agent/model";

export const STELLA_PROVIDER = "stella";
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;

export type StellaCatalogModel = {
  id: string;
  name: string;
  provider: typeof STELLA_PROVIDER;
  upstreamModel: string;
  type: "language";
};

export type StellaDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash": "Gemini 3 Flash",
  "inception/mercury-2": "Mercury 2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "openai/gpt-5.4": "GPT-5.4",
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

const listUpstreamManagedModels = (): string[] => {
  const models = new Set<string>();

  const appendModel = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) {
      models.add(trimmed);
    }
  };

  appendModel(DEFAULT_MODEL.model);
  appendModel(DEFAULT_MODEL.fallback);

  for (const config of Object.values(AGENT_MODELS)) {
    appendModel(config.model);
    appendModel(config.fallback);
  }

  return Array.from(models).sort((a, b) => deriveDisplayName(a).localeCompare(deriveDisplayName(b)));
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
): string => {
  const trimmed = selection?.trim();
  if (!trimmed || trimmed === STELLA_DEFAULT_MODEL) {
    return getModelConfig(agentType).model;
  }

  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return trimmed;
  }

  const upstreamModel = trimmed.slice(`${STELLA_PROVIDER}/`.length).trim();
  if (!upstreamModel || upstreamModel === "default") {
    return getModelConfig(agentType).model;
  }

  return upstreamModel;
};

export const listStellaCatalogModels = (): StellaCatalogModel[] => [
  {
    id: STELLA_DEFAULT_MODEL,
    name: "Stella Recommended",
    provider: "stella",
    upstreamModel: "",
    type: "language",
  },
  ...listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => ({
    id: toStellaModelId(upstreamModel),
    name: deriveDisplayName(upstreamModel),
    provider: STELLA_PROVIDER,
    upstreamModel,
    type: "language",
  })),
];

export const listStellaDefaultSelections = (): StellaDefaultEntry[] =>
  Object.entries(AGENT_MODELS).map(([agentType, config]) => ({
    agentType,
    model: STELLA_DEFAULT_MODEL,
    resolvedModel: config.model,
  }));
