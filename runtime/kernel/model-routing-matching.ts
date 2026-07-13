import { getModelProviders, getModels } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";

export type ParsedModelReference = {
  provider: string;
  modelId: string;
  fullModelId: string;
};

export const parseModelReference = (
  rawModel: string | undefined,
): ParsedModelReference | null => {
  const value = rawModel?.trim();
  if (!value) return null;
  if (!value.includes("/")) {
    return {
      provider: value,
      modelId: value,
      fullModelId: value,
    };
  }
  const parts = value.split("/");
  const provider = (parts.shift() || "").trim().toLowerCase();
  const modelId = parts.join("/").trim();
  if (!provider || !modelId) return null;
  return {
    provider,
    modelId,
    fullModelId: `${provider}/${modelId}`,
  };
};

export const uniqueModelCandidates = (values: string[]): string[] =>
  Array.from(new Set(values.filter(Boolean)));

const OPEN_ENDED_GATEWAY_PROVIDERS = new Set([
  "openrouter",
  "vercel-ai-gateway",
]);

/** Gateways whose provider owns an open-ended model-id namespace. */
export const isOpenEndedGatewayProvider = (provider: string): boolean =>
  OPEN_ENDED_GATEWAY_PROVIDERS.has(provider.trim().toLowerCase());

/** Upstream id carried verbatim by a `stella/<provider>/<model>` reference. */
export const getStellaVerbatimUpstreamModel = (
  rawModel: string,
): string | null => {
  const parsed = parseModelReference(rawModel);
  if (parsed?.provider !== "stella" || !parsed.modelId.includes("/")) {
    return null;
  }
  return parsed.modelId;
};

/**
 * References routing accepts verbatim instead of validating against a closed
 * registry namespace. Colons in these references are always model-id data,
 * never spawn-agent effort delimiters.
 */
export const isOpenEndedModelReference = (rawModel: string): boolean => {
  const parsed = parseModelReference(rawModel);
  if (!parsed) return false;
  if (isOpenEndedGatewayProvider(parsed.provider)) return true;
  return getStellaVerbatimUpstreamModel(rawModel) !== null;
};

const getRegistryModels = (registryProvider: string): Model<Api>[] => {
  const models = getModels(registryProvider as never) as Model<Api>[];
  return Array.isArray(models) ? models : [];
};

export type RegistryModelMatch = {
  registryProvider: string;
  model: Model<Api>;
};

/** Exact id matches across every live registry namespace. */
export const findRegistryModelsById = (
  modelId: string,
): RegistryModelMatch[] => {
  const requested = modelId.trim();
  if (!requested) return [];
  return getModelProviders().flatMap((registryProvider) =>
    getRegistryModels(registryProvider)
      .filter((model) => model.id === requested)
      .map((model) => ({ registryProvider, model })),
  );
};

/** A closed `stella/<bare-id>` reference backed by any registry namespace. */
export const isRegisteredBareStellaModelReference = (
  rawModel: string,
): boolean => {
  const parsed = parseModelReference(rawModel);
  return Boolean(
    parsed?.provider === "stella" &&
      !parsed.modelId.includes("/") &&
      findRegistryModelsById(parsed.modelId).length > 0,
  );
};

export const getEngineNativeStellaModelAlternative = (
  rawModel: string,
  reasoningEffort?: string,
): string | undefined => {
  const parsed = parseModelReference(rawModel);
  if (!parsed || parsed.provider !== "stella" || parsed.modelId.includes("/")) {
    return undefined;
  }
  const matches = findRegistryModelsById(parsed.modelId);
  const engine = matches.some(
    ({ registryProvider }) => registryProvider === "openai-codex",
  )
    ? "codex"
    : matches.some(({ registryProvider }) => registryProvider === "anthropic")
      ? "claude-code"
      : undefined;
  if (!engine) return undefined;
  return `${engine}/${parsed.modelId}${reasoningEffort ? `:${reasoningEffort}` : ""}`;
};

export const findRegistryModel = (
  registryProvider: string,
  requestedCandidates: string[],
): Model<Api> | null => {
  const models = getRegistryModels(registryProvider);
  if (models.length === 0) {
    return null;
  }

  for (const candidate of requestedCandidates) {
    const exact = models.find((model) => model.id === candidate);
    if (exact) {
      return exact;
    }
  }

  for (const candidate of requestedCandidates) {
    const canonical = models.find(
      (model) => `${model.provider}/${model.id}` === candidate,
    );
    if (canonical) {
      return canonical;
    }
  }

  for (const candidate of requestedCandidates) {
    const normalizedCandidate = candidate.replace(/\./g, "-");
    const normalized = models.find((model) => model.id === normalizedCandidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};
