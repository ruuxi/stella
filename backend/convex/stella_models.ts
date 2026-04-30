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
export const STELLA_STANDARD_MODEL = `${STELLA_PROVIDER}/standard`;
export const STELLA_FREE_MODEL = `${STELLA_PROVIDER}/free`;
export const STELLA_FAST_MODEL = `${STELLA_PROVIDER}/fast`;
export const STELLA_SMART_MODEL = `${STELLA_PROVIDER}/smart`;
export const STELLA_BEST_MODEL = `${STELLA_PROVIDER}/best`;
export const STELLA_SOTA_MODEL = `${STELLA_PROVIDER}/sota`;
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
  "anthropic/claude-opus-4.7": "Claude Opus 4.7",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "inception/mercury-2": "Mercury 2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "openai/gpt-5.4": "GPT-5.4",
  "openai/gpt-5.4-mini": "GPT-5.4 Mini",
  "openai/gpt-5.5": "GPT-5.5",
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
  const rawId = upstreamModel.startsWith("accounts/fireworks/models/")
    ? upstreamModel.slice("accounts/fireworks/models/".length)
    : upstreamModel.startsWith("accounts/fireworks/routers/")
      ? upstreamModel.slice("accounts/fireworks/routers/".length)
      : slash >= 0
        ? upstreamModel.slice(slash + 1)
        : upstreamModel;
  return titleCase(rawId);
};

const STELLA_ALIAS_MODES = [
  {
    id: STELLA_STANDARD_MODEL,
    name: "Stella Standard",
    mode: "standard",
    type: "language" as const,
  },
  {
    id: STELLA_FREE_MODEL,
    name: "Stella Free",
    mode: "free",
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
    id: STELLA_SOTA_MODEL,
    name: "Stella SOTA",
    mode: "sota",
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

export const parseStellaModelSelection = (
  selection: string | null | undefined,
): { kind: "default" } | { kind: "mode"; mode: ModelMode } | { kind: "upstream"; model: string } | null => {
  const trimmed = selection?.trim();
  if (!trimmed || trimmed === STELLA_DEFAULT_MODEL) {
    return { kind: "default" };
  }
  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return null;
  }

  const aliasOrUpstreamModel = trimmed.slice(`${STELLA_PROVIDER}/`.length).trim();
  if (!aliasOrUpstreamModel || aliasOrUpstreamModel === "default") {
    return { kind: "default" };
  }

  const modeKey =
    aliasOrUpstreamModel === "cheap" ? "standard" : aliasOrUpstreamModel;
  if (isModelMode(modeKey)) {
    return { kind: "mode", mode: modeKey };
  }

  return { kind: "upstream", model: aliasOrUpstreamModel };
};

export const resolveStellaModelSelection = (
  agentType: string,
  selection?: string | null,
  audience: ManagedModelAudience = "free",
): string => {
  const parsed = parseStellaModelSelection(selection);
  if (!parsed) {
    return selection?.trim() || getModelConfig(agentType, audience).model;
  }
  if (parsed.kind === "default") {
    return getModelConfig(agentType, audience).model;
  }
  if (parsed.kind === "mode") {
    return getModeConfig(parsed.mode, audience).model;
  }
  return parsed.model;
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
