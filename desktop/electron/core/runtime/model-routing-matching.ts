import { getModels } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";

const DATED_MODEL_SUFFIX_RE = /-\d{8}$/;

const DEFAULT_DIRECT_MODEL_IDS: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  "openai-codex": "gpt-5.4",
  google: "gemini-2.5-pro",
  groq: "openai/gpt-oss-120b",
  mistral: "mistral-medium-2508",
  opencode: "claude-opus-4-6",
  cerebras: "zai-glm-4.6",
  xai: "grok-4-fast-non-reasoning",
  zai: "glm-4.6",
  "kimi-coding": "kimi-k2-thinking",
  openrouter: "openai/gpt-5.1-codex",
  "vercel-ai-gateway": "anthropic/claude-opus-4-6",
};

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

const isAliasModelId = (id: string): boolean =>
  id.endsWith("-latest") || !DATED_MODEL_SUFFIX_RE.test(id);

const getRegistryModels = (registryProvider: string): Model<Api>[] => {
  const models = getModels(registryProvider as never) as Model<Api>[];
  return Array.isArray(models) ? models : [];
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
    const prefix = `${normalizedCandidate}-`;
    const prefixed = models.find(
      (model) =>
        model.id === normalizedCandidate || model.id.startsWith(prefix),
    );
    if (prefixed) {
      return prefixed;
    }
  }

  const partialMatches = requestedCandidates.flatMap((candidate) => {
    const normalizedCandidate = candidate.trim().toLowerCase();
    if (!normalizedCandidate) {
      return [];
    }
    return models.filter((model) => {
      const modelId = model.id.toLowerCase();
      const modelName = model.name?.toLowerCase() ?? "";
      const canonicalId = `${model.provider}/${model.id}`.toLowerCase();
      return (
        modelId.includes(normalizedCandidate) ||
        modelName.includes(normalizedCandidate) ||
        canonicalId.includes(normalizedCandidate)
      );
    });
  });

  if (partialMatches.length === 0) {
    return null;
  }

  const uniqueMatches = Array.from(new Set(partialMatches));
  uniqueMatches.sort((left, right) => {
    const aliasScore =
      Number(isAliasModelId(right.id)) - Number(isAliasModelId(left.id));
    if (aliasScore !== 0) {
      return aliasScore;
    }
    return right.id.localeCompare(left.id);
  });
  return uniqueMatches[0] ?? null;
};

export const buildFallbackRegistryModel = (
  registryProvider: string,
  requestedModelId: string,
): Model<Api> | null => {
  const models = getRegistryModels(registryProvider);
  if (models.length === 0) {
    return null;
  }

  const preferredId = DEFAULT_DIRECT_MODEL_IDS[registryProvider];
  const baseModel = preferredId
    ? models.find((model) => model.id === preferredId) ?? models[0]
    : models[0];

  if (!baseModel) {
    return null;
  }

  return {
    ...baseModel,
    id: requestedModelId,
    name: requestedModelId,
  };
};
