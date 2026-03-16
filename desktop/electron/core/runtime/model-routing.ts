import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../../../src/shared/contracts/agent-runtime.js";
import { getLocalLlmCredential } from "./storage/llm-credentials.js";
import { STELLA_DEFAULT_MODEL } from "./stella-provider.js";
import { getDirectProviderCandidates } from "./model-routing-direct.js";
import {
  findRegistryModel,
  parseModelReference,
  uniqueModelCandidates,
} from "./model-routing-matching.js";
import {
  createStellaRoute,
  STELLA_PROVIDER,
  type StellaProxyConfig,
} from "./model-routing-stella.js";

export type ResolvedLlmRoute = {
  model: Model<Api>;
  route: "direct-provider" | "direct-openrouter" | "direct-gateway" | "stella";
  getApiKey: () => string | undefined;
};

const getCredential = (
  stellaHomePath: string,
  providerId: string,
): string | null => getLocalLlmCredential(stellaHomePath, providerId);

const getGatewayCredential = (stellaHomePath: string): string | null =>
  getCredential(stellaHomePath, "vercel-ai-gateway");

const resolveDirectProviderRoute = (args: {
  stellaHomePath: string;
  provider: string;
  modelId: string;
  fullModelId: string;
}): ResolvedLlmRoute | null => {
  const directProvider = getDirectProviderCandidates(args.provider, args.modelId);
  if (!directProvider) {
    return null;
  }

  const directKey = getCredential(
    args.stellaHomePath,
    directProvider.credentialProvider,
  );

  const requestedCandidates = uniqueModelCandidates([
    args.fullModelId,
    ...directProvider.candidates,
  ]);

  if (directKey) {
    const directModel = findRegistryModel(
      directProvider.registryProvider,
      requestedCandidates,
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
      requestedCandidates,
    );
    if (directModel?.baseUrl) {
      return {
        model: directModel,
        route: "direct-provider",
        getApiKey: () => "",
      };
    }
  }

  return null;
};

const resolveOpenRouterRoute = (args: {
  stellaHomePath: string;
  fullModelId: string;
}): ResolvedLlmRoute | null => {
  const openrouterKey = getCredential(args.stellaHomePath, "openrouter");
  if (!openrouterKey) {
    return null;
  }

  const openrouterModel = findRegistryModel("openrouter", [args.fullModelId]);
  if (openrouterModel) {
    return {
      model: openrouterModel,
      route: "direct-openrouter",
      getApiKey: () => openrouterKey,
    };
  }
  return null;
};

const resolveGatewayRoute = (args: {
  stellaHomePath: string;
  fullModelId: string;
}): ResolvedLlmRoute | null => {
  const gatewayKey = getGatewayCredential(args.stellaHomePath);
  if (!gatewayKey) {
    return null;
  }

  const gatewayModel = findRegistryModel("vercel-ai-gateway", [
    args.fullModelId,
  ]);
  if (gatewayModel) {
    return {
      model: gatewayModel,
      route: "direct-gateway",
      getApiKey: () => gatewayKey,
    };
  }
  return null;
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
  const parsed = parseModelReference(args.modelName);

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
    const directProviderRoute = resolveDirectProviderRoute({
      stellaHomePath: args.stellaHomePath,
      provider: parsed.provider,
      modelId: parsed.modelId,
      fullModelId: parsed.fullModelId,
    });
    if (directProviderRoute) {
      return directProviderRoute;
    }

    const openRouterRoute = resolveOpenRouterRoute({
      stellaHomePath: args.stellaHomePath,
      fullModelId: parsed.fullModelId,
    });
    if (openRouterRoute) {
      return openRouterRoute;
    }

    const gatewayRoute = resolveGatewayRoute({
      stellaHomePath: args.stellaHomePath,
      fullModelId: parsed.fullModelId,
    });
    if (gatewayRoute) {
      return gatewayRoute;
    }

    const stellaRoute = createStellaRoute({
      proxy: args.proxy,
      agentType: args.agentType,
      modelId: `${STELLA_PROVIDER}/${parsed.fullModelId}`,
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
