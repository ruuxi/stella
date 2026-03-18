import { getModels } from "../ai/models.js";
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
    const normalized = models.find((model) => model.id === normalizedCandidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};
