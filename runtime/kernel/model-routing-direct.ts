import { getModels } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";
import { uniqueModelCandidates } from "./model-routing-matching.js";

export type DirectProviderCandidates = {
  credentialProvider: string;
  registryProvider: string;
  candidates: string[];
  allowBaseUrlWithoutCredential?: boolean;
};

export const getDirectProviderCandidates = (
  provider: string,
  modelId: string,
): DirectProviderCandidates | null => {
  switch (provider) {
    case "anthropic":
      return {
        credentialProvider: "anthropic",
        registryProvider: "anthropic",
        candidates: uniqueModelCandidates([modelId, modelId.replace(/\./g, "-")]),
      };
    case "moonshotai":
      return {
        credentialProvider: "kimi-coding",
        registryProvider: "kimi-coding",
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
          modelId === "kimi-k2.5" ? "k2p5" : "",
          modelId === "kimi-k2" ? "kimi-k2" : "",
        ]),
      };
    case "openai":
    case "openai-codex":
    case "google":
    case "groq":
    case "mistral":
    case "opencode":
    case "cerebras":
    case "xai":
    case "zai":
      return {
        credentialProvider: provider,
        registryProvider: provider,
        candidates: uniqueModelCandidates([modelId, modelId.replace(/\./g, "-")]),
      };
    default: {
      const extensionModels = getModels(provider as never) as Model<Api>[];
      if (extensionModels.length > 0) {
        return {
          credentialProvider: provider,
          registryProvider: provider,
          allowBaseUrlWithoutCredential: true,
          candidates: uniqueModelCandidates([modelId, modelId.replace(/\./g, "-")]),
        };
      }
      return null;
    }
  }
};
