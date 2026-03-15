import { getModels } from "../ai/models.js";
import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { getLocalLlmCredential } from "./storage/llm-credentials.js";
import {
  normalizeStellaApiBaseUrl,
  STELLA_DEFAULT_MODEL,
} from "./stella-provider.js";

type StellaProxyConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
};

export type ResolvedLlmRoute = {
  model: Model<Api>;
  route: "direct-provider" | "direct-openrouter" | "direct-gateway" | "stella";
  getApiKey: () => string | undefined;
};

const STELLA_CONTEXT_WINDOW = 256_000;
const STELLA_MAX_TOKENS = 16_384;
const STELLA_PROVIDER = "stella";

const createStellaModel = (
  proxyBaseUrl: string,
  modelId: string,
  agentType: string,
): Model<"openai-completions"> => ({
  id: modelId,
  name:
    modelId === STELLA_DEFAULT_MODEL
      ? "Stella Recommended"
      : modelId.replace(/^stella\//, ""),
  api: "openai-completions",
  provider: STELLA_PROVIDER,
  baseUrl: normalizeStellaApiBaseUrl(proxyBaseUrl),
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: STELLA_CONTEXT_WINDOW,
  maxTokens: STELLA_MAX_TOKENS,
  headers: {
    "X-Stella-Agent-Type": agentType,
  },
  compat: {
    supportsDeveloperRole: true,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: "max_completion_tokens",
    supportsStrictMode: false,
  },
});

const normalizeStellaBase = (
  value: string | null | undefined,
): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.includes("/api/stella/v1")) {
    return normalized;
  }
  return `${normalized.replace(".convex.cloud", ".convex.site")}/api/stella/v1`;
};

const parseModel = (
  rawModel: string | undefined,
): { provider: string; modelId: string; fullModelId: string } | null => {
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

const unique = (values: string[]): string[] =>
  Array.from(new Set(values.filter(Boolean)));

const getCredential = (
  stellaHomePath: string,
  providerId: string,
): string | null => {
  return getLocalLlmCredential(stellaHomePath, providerId);
};

const getDirectProviderCandidates = (
  provider: string,
  modelId: string,
): {
  credentialProvider: string;
  registryProvider: string;
  candidates: string[];
  allowBaseUrlWithoutCredential?: boolean;
} | null => {
  switch (provider) {
    case "anthropic":
      return {
        credentialProvider: "anthropic",
        registryProvider: "anthropic",
        candidates: unique([modelId, modelId.replace(/\./g, "-")]),
      };
    case "moonshotai":
      return {
        credentialProvider: "kimi-coding",
        registryProvider: "kimi-coding",
        candidates: unique([
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
        candidates: unique([modelId, modelId.replace(/\./g, "-")]),
      };
    default: {
      const extensionModels = getModels(provider as never) as Model<Api>[];
      if (extensionModels.length > 0) {
        return {
          credentialProvider: provider,
          registryProvider: provider,
          allowBaseUrlWithoutCredential: true,
          candidates: unique([modelId, modelId.replace(/\./g, "-")]),
        };
      }
      return null;
    }
  }
};

const findRegistryModel = (
  registryProvider: string,
  requestedCandidates: string[],
): Model<Api> | null => {
  const models = getModels(registryProvider as never) as Model<Api>[];
  if (!Array.isArray(models) || models.length === 0) {
    return null;
  }

  for (const candidate of requestedCandidates) {
    const exact = models.find((model) => model.id === candidate);
    if (exact) {
      return exact;
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

  return null;
};

const getGatewayCredential = (stellaHomePath: string): string | null =>
  getCredential(stellaHomePath, "vercel-ai-gateway");

const createStellaRoute = (args: {
  proxy: StellaProxyConfig;
  agentType: string;
  modelId: string;
}): ResolvedLlmRoute | null => {
  const proxyBaseUrl = normalizeStellaBase(args.proxy.baseUrl);
  const authToken = args.proxy.getAuthToken()?.trim();
  if (!proxyBaseUrl || !authToken) {
    return null;
  }

  return {
    route: "stella",
    model: createStellaModel(proxyBaseUrl, args.modelId, args.agentType),
    getApiKey: () => args.proxy.getAuthToken()?.trim() || authToken,
  };
};

export const canResolveLlmRoute = (args: {
  stellaHomePath: string;
  modelName: string | undefined;
  agentType?: string;
  proxy: StellaProxyConfig;
}): boolean => {
  try {
    resolveLlmRoute({
      ...args,
      agentType: args.agentType ?? AGENT_IDS.ORCHESTRATOR,
    });
    return true;
  } catch {
    return false;
  }
};

export const resolveLlmRoute = (args: {
  stellaHomePath: string;
  modelName: string | undefined;
  agentType: string;
  proxy: StellaProxyConfig;
}): ResolvedLlmRoute => {
  const parsed = parseModel(args.modelName);

  if (parsed?.provider === STELLA_PROVIDER) {
    const route = createStellaRoute({
      proxy: args.proxy,
      agentType: args.agentType,
      modelId: parsed.fullModelId,
    });
    if (route) {
      return route;
    }
  }

  if (parsed) {
    const { provider, modelId, fullModelId } = parsed;

    const directProvider = getDirectProviderCandidates(provider, modelId);
    if (directProvider) {
      const directKey = getCredential(
        args.stellaHomePath,
        directProvider.credentialProvider,
      );
      if (directKey) {
        const directModel = findRegistryModel(
          directProvider.registryProvider,
          directProvider.candidates,
        );
        if (directModel) {
          return {
            model: directModel,
            route: "direct-provider",
            getApiKey: () => directKey,
          };
        }
      }

      if (!directKey && directProvider.allowBaseUrlWithoutCredential) {
        const directModel = findRegistryModel(
          directProvider.registryProvider,
          directProvider.candidates,
        );
        if (directModel?.baseUrl) {
          return {
            model: directModel,
            route: "direct-provider",
            getApiKey: () => "",
          };
        }
      }
    }

    const openrouterKey = getCredential(args.stellaHomePath, "openrouter");
    if (openrouterKey) {
      const openrouterModel = findRegistryModel("openrouter", [fullModelId]);
      if (openrouterModel) {
        return {
          model: openrouterModel,
          route: "direct-openrouter",
          getApiKey: () => openrouterKey,
        };
      }
    }

    const gatewayKey = getGatewayCredential(args.stellaHomePath);
    if (gatewayKey) {
      const gatewayModel = findRegistryModel("vercel-ai-gateway", [
        fullModelId,
      ]);
      if (gatewayModel) {
        return {
          model: gatewayModel,
          route: "direct-gateway",
          getApiKey: () => gatewayKey,
        };
      }
    }

    const stellaRoute = createStellaRoute({
      proxy: args.proxy,
      agentType: args.agentType,
      modelId: `${STELLA_PROVIDER}/${fullModelId}`,
    });
    if (stellaRoute) {
      return stellaRoute;
    }
  }

  const defaultStellaRoute = createStellaRoute({
    proxy: args.proxy,
    agentType: args.agentType,
    modelId: STELLA_DEFAULT_MODEL,
  });
  if (defaultStellaRoute) {
    return defaultStellaRoute;
  }

  throw new Error(
    "No usable model route is configured. Add a matching local API key in Settings or sign in to use Stella.",
  );
};
