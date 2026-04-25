import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../../desktop/src/shared/contracts/agent-runtime.js";
import { getModels } from "../ai/models.js";
import { getLocalLlmCredential } from "./storage/llm-credentials.js";
import {
  getLocalLlmOAuthApiKey,
  hasLocalLlmOAuthCredential,
} from "./storage/llm-oauth-credentials.js";
import { STELLA_DEFAULT_MODEL } from "../../desktop/src/shared/stella-api.js";
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
import { getLocalLlmProviderPreference } from "./preferences/local-preferences.js";

export type ResolvedLlmRoute = {
  model: Model<Api>;
  route: "direct-provider" | "direct-gateway" | "stella";
  getApiKey: () => Promise<string | undefined> | string | undefined;
};

export const getResolvedLlmApiKey = async (
  resolved: ResolvedLlmRoute,
): Promise<string | undefined> => {
  const apiKey = (await resolved.getApiKey())?.trim();
  return apiKey ? apiKey : undefined;
};

export const resolvedLlmSupportsCredentiallessCalls = (
  resolved: ResolvedLlmRoute,
): boolean =>
  resolved.route === "direct-provider" && resolved.model.baseUrl.trim().length > 0;

const getCredential = (
  stellaRoot: string,
  providerId: string,
): string | null => getLocalLlmCredential(stellaRoot, providerId);

const hasLocalProviderAuth = (stellaRoot: string, providerId: string): boolean =>
  Boolean(getCredential(stellaRoot, providerId)) ||
  hasLocalLlmOAuthCredential(stellaRoot, providerId);

const getLocalProviderApiKey = async (
  stellaRoot: string,
  providerId: string,
): Promise<string | undefined> => {
  const apiKey = getCredential(stellaRoot, providerId)?.trim();
  if (apiKey) return apiKey;
  const oauthKey = (await getLocalLlmOAuthApiKey(stellaRoot, providerId))?.trim();
  return oauthKey || undefined;
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

  const hasAuth = hasLocalProviderAuth(
    args.stellaRoot,
    directProvider.credentialProvider,
  );

  const requestedCandidates = uniqueModelCandidates([
    args.fullModelId,
    ...directProvider.candidates,
  ]);

  if (hasAuth) {
    const directModel = findRegistryModel(
      directProvider.registryProvider,
      requestedCandidates,
    );
    if (directModel) {
      return {
        model: directModel,
        route: "direct-provider",
        getApiKey: () =>
          getLocalProviderApiKey(
            args.stellaRoot,
            directProvider.credentialProvider,
          ),
      };
    }
  }

  if (!hasAuth && directProvider.allowBaseUrlWithoutCredential) {
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
  if (!hasLocalProviderAuth(args.stellaRoot, "openrouter")) {
    return null;
  }

  const openrouterModel = findRegistryModel("openrouter", args.requestedCandidates);
  if (openrouterModel) {
    return {
      model: openrouterModel,
      route: "direct-provider",
      getApiKey: () => getLocalProviderApiKey(args.stellaRoot, "openrouter"),
    };
  }
  return null;
};

const resolveGatewayRoute = (args: {
  stellaRoot: string;
  requestedCandidates: string[];
}): ResolvedLlmRoute | null => {
  if (!hasLocalProviderAuth(args.stellaRoot, "vercel-ai-gateway")) {
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
      getApiKey: () =>
        getLocalProviderApiKey(args.stellaRoot, "vercel-ai-gateway"),
    };
  }
  return null;
};

const resolveParsedProviderRoute = (args: {
  stellaRoot: string;
  parsed: NonNullable<ReturnType<typeof parseModelReference>>;
  selectedProvider: string;
}): ResolvedLlmRoute | null => {
  const requestedCandidates = uniqueModelCandidates([
    args.parsed.fullModelId,
    args.parsed.modelId,
  ]);

  switch (args.selectedProvider) {
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
        provider: args.selectedProvider,
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

  const localProviderPreference = getLocalLlmProviderPreference(args.stellaRoot);
  if (!localProviderPreference.enabled) {
    return (
      createStellaRoute({
        site: args.site,
        agentType: args.agentType,
        modelId: `${STELLA_PROVIDER}/${parsed.fullModelId}`,
      }) ?? null
    );
  }

  const directProviderRoute = resolveParsedProviderRoute({
    stellaRoot: args.stellaRoot,
    parsed,
    selectedProvider: localProviderPreference.provider,
  });
  if (directProviderRoute) {
    return directProviderRoute;
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
