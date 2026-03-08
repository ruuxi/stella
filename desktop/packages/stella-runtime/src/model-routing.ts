import { getModels, type Api, type Model } from "../../stella-ai/src/index.js";
import { getLocalLlmCredential, hasLocalLlmCredential } from "./storage/llm-credentials.js";

type ManagedProxyConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
};

export type ResolvedLlmRoute = {
  model: Model<Api>;
  route: "direct-provider" | "direct-openrouter" | "direct-gateway" | "managed-proxy";
  getApiKey: () => string | undefined;
};

const normalizeProxyBase = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/, "");
  if (normalized.includes("/api/ai/v1")) {
    return normalized;
  }
  return `${normalized.replace(".convex.cloud", ".convex.site")}/api/ai/v1`;
};

const parseModel = (rawModel: string | undefined): { provider: string; modelId: string; fullModelId: string } | null => {
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

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

const getCredential = (stellaHomePath: string, providerId: string): string | null => {
  return getLocalLlmCredential(stellaHomePath, providerId);
};

const hasCredential = (stellaHomePath: string, providerId: string): boolean => {
  return hasLocalLlmCredential(stellaHomePath, providerId);
};

const getDirectProviderCandidates = (
  provider: string,
  modelId: string,
): { credentialProvider: string; registryProvider: string; candidates: string[] } | null => {
  switch (provider) {
    case "anthropic":
      return {
        credentialProvider: "anthropic",
        registryProvider: "anthropic",
        candidates: unique([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
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
        candidates: unique([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
      };
    default:
      return null;
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
    const prefixed = models.find((model) =>
      model.id === normalizedCandidate || model.id.startsWith(prefix));
    if (prefixed) {
      return prefixed;
    }
  }

  return null;
};

const createManagedProxyModel = (
  fullModelId: string,
  provider: string,
  proxyBaseUrl: string,
  agentType: string,
): Model<"openai-completions"> => ({
  id: fullModelId,
  name: fullModelId,
  api: "openai-completions",
  provider,
  baseUrl: proxyBaseUrl,
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 256_000,
  maxTokens: 16_384,
  headers: {
    "X-Provider": provider,
    "X-Model-Id": fullModelId,
    "X-Agent-Type": agentType,
  },
  compat: {
    supportsStrictMode: false,
  },
});

const getGatewayCredential = (stellaHomePath: string): string | null =>
  getCredential(stellaHomePath, "vercel-ai-gateway");

const hasGatewayCredential = (stellaHomePath: string): boolean =>
  hasCredential(stellaHomePath, "vercel-ai-gateway");

export const canResolveLlmRoute = (args: {
  stellaHomePath: string;
  modelName: string | undefined;
  agentType?: string;
  proxy: ManagedProxyConfig;
}): boolean => {
  try {
    resolveLlmRoute({
      ...args,
      agentType: args.agentType ?? "orchestrator",
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
  proxy: ManagedProxyConfig;
}): ResolvedLlmRoute => {
  const parsed = parseModel(args.modelName);

  // When a model is explicitly specified, try direct provider / openrouter / gateway routes
  if (parsed) {
    const { provider, modelId, fullModelId } = parsed;

    const directProvider = getDirectProviderCandidates(provider, modelId);
    if (directProvider) {
      const directKey = getCredential(args.stellaHomePath, directProvider.credentialProvider);
      if (directKey) {
        const directModel = findRegistryModel(directProvider.registryProvider, directProvider.candidates);
        if (directModel) {
          return {
            model: directModel,
            route: "direct-provider",
            getApiKey: () => directKey,
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
      const gatewayModel = findRegistryModel("vercel-ai-gateway", [fullModelId]);
      if (gatewayModel) {
        return {
          model: gatewayModel,
          route: "direct-gateway",
          getApiKey: () => gatewayKey,
        };
      }
    }
  }

  // Managed proxy path — model may be undefined (backend decides)
  const proxyBaseUrl = normalizeProxyBase(args.proxy.baseUrl);
  const authToken = args.proxy.getAuthToken()?.trim();
  if (proxyBaseUrl && authToken) {
    const fullModelId = parsed?.fullModelId ?? "";
    const provider = parsed?.provider ?? "";
    return {
      model: createManagedProxyModel(fullModelId, provider, proxyBaseUrl, args.agentType),
      route: "managed-proxy",
      getApiKey: () => args.proxy.getAuthToken()?.trim() || authToken,
    };
  }

  throw new Error(
    "No usable model route is configured. Add a matching local API key in Settings or sign in to use Stella's managed route.",
  );
};
