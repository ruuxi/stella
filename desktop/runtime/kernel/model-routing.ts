import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../../src/shared/contracts/agent-runtime.js";
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
  type StellaSiteConfig,
} from "./model-routing-stella.js";

export type ResolvedLlmRoute = {
  model: Model<Api>;
  route: "direct-provider" | "direct-openrouter" | "direct-gateway" | "stella";
  getApiKey: () => string | undefined;
};

const getCredential = (
  stellaRoot: string,
  providerId: string,
): string | null => getLocalLlmCredential(stellaRoot, providerId);

const getGatewayCredential = (stellaRoot: string): string | null =>
  getCredential(stellaRoot, "vercel-ai-gateway");

const resolveDirectProviderRoute = (args: {
  stellaRoot: string;
  provider: string;
  modelId: string;
  fullModelId: string;
}): ResolvedLlmRoute | null => {
  const directProvider = getDirectProviderCandidates(args.provider, args.modelId);
  if (!directProvider) {
    return null;
  }

  const directKey = getCredential(
    args.stellaRoot,
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
  stellaRoot: string;
  requestedCandidates: string[];
}): ResolvedLlmRoute | null => {
  const openrouterKey = getCredential(args.stellaRoot, "openrouter");
  if (!openrouterKey) {
    return null;
  }

  const openrouterModel = findRegistryModel("openrouter", args.requestedCandidates);
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
  stellaRoot: string;
  requestedCandidates: string[];
}): ResolvedLlmRoute | null => {
  const gatewayKey = getGatewayCredential(args.stellaRoot);
  if (!gatewayKey) {
    return null;
  }

  const gatewayModel = findRegistryModel(
    "vercel-ai-gateway",
    args.requestedCandidates,
  );
  if (gatewayModel) {
    return {
      model: gatewayModel,
      route: "direct-gateway",
      getApiKey: () => gatewayKey,
    };
  }
  return null;
};

const resolveParsedProviderRoute = (args: {
  stellaRoot: string;
  parsed: NonNullable<ReturnType<typeof parseModelReference>>;
}): ResolvedLlmRoute | null => {
  const requestedCandidates = uniqueModelCandidates([
    args.parsed.fullModelId,
    args.parsed.modelId,
  ]);

  switch (args.parsed.provider) {
    case "openrouter":
      return resolveOpenRouterRoute({
        stellaRoot: args.stellaRoot,
        requestedCandidates,
      });
    case "vercel-ai-gateway":
      return resolveGatewayRoute({
        stellaRoot: args.stellaRoot,
        requestedCandidates,
      });
    default:
      return resolveDirectProviderRoute({
        stellaRoot: args.stellaRoot,
        provider: args.parsed.provider,
        modelId: args.parsed.modelId,
        fullModelId: args.parsed.fullModelId,
      });
  }
};

const resolveMaybeLlmRoute = (args: {
  stellaRoot: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
}): ResolvedLlmRoute | null => {
  const parsed = parseModelReference(args.modelName);

  if (parsed?.provider === STELLA_PROVIDER) {
    return createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: parsed.fullModelId,
    });
  }

  if (!parsed) {
    return (
      createStellaRoute({
        site: args.site,
        agentType: args.agentType,
        modelId: STELLA_DEFAULT_MODEL,
      }) ?? null
    );
  }

  const directProviderRoute = resolveParsedProviderRoute({
    stellaRoot: args.stellaRoot,
    parsed,
  });
  if (directProviderRoute) {
    return directProviderRoute;
  }

  // When the explicit provider didn't resolve, try OpenRouter and Gateway as
  // fallbacks before giving up. Users with an OpenRouter key expect
  // "openai/gpt-5.1-codex" to route through OpenRouter when no direct key exists.
  const fallbackCandidates = uniqueModelCandidates([
    parsed.fullModelId,
    parsed.modelId,
  ]);

  if (parsed.provider !== "openrouter") {
    const openRouterFallback = resolveOpenRouterRoute({
      stellaRoot: args.stellaRoot,
      requestedCandidates: fallbackCandidates,
    });
    if (openRouterFallback) {
      return openRouterFallback;
    }
  }

  if (parsed.provider !== "vercel-ai-gateway") {
    const gatewayFallback = resolveGatewayRoute({
      stellaRoot: args.stellaRoot,
      requestedCandidates: fallbackCandidates,
    });
    if (gatewayFallback) {
      return gatewayFallback;
    }
  }

  return (
    createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: `${STELLA_PROVIDER}/${parsed.fullModelId}`,
    }) ?? null
  );
};

export const canResolveLlmRoute = (args: {
  stellaRoot: string;
  modelName: string | undefined;
  agentType?: string;
  site: StellaSiteConfig;
}): boolean =>
  Boolean(
    resolveMaybeLlmRoute({
      ...args,
      agentType: args.agentType ?? AGENT_IDS.ORCHESTRATOR,
    }),
  );

export const resolveLlmRoute = (args: {
  stellaRoot: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
}): ResolvedLlmRoute => {
  const route = resolveMaybeLlmRoute(args);
  if (route) return route;

  throw new Error(
    "No usable model route is configured. Add a matching local API key in Settings or sign in to use Stella.",
  );
};
