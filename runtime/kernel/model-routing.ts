import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../contracts/agent-runtime.js";
import { getModels } from "../ai/models.js";
import { getLocalLlmCredential } from "./storage/llm-credentials.js";
import {
  getLocalLlmOAuthApiKey,
  hasLocalLlmOAuthCredential,
} from "./storage/llm-oauth-credentials.js";
import { STELLA_DEFAULT_MODEL } from "../contracts/stella-api.js";
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
import { isLocalLlmKeysEnabled } from "./preferences/local-preferences.js";

export type ResolvedLlmRoute = {
  model: Model<Api>;
  toolPolicyModel?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
  route: "direct-provider" | "stella";
  getApiKey: () => Promise<string | undefined> | string | undefined;
  refreshApiKey?: () => Promise<string | undefined> | string | undefined;
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

/**
 * Per-provider quirks — registry name + credential name + model-id aliases.
 * Most providers map 1:1 between the model-id prefix, the registry key, and
 * the credential key. The exceptions get an entry here.
 */
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
    case "openrouter":
    case "vercel-ai-gateway":
      return {
        credentialProvider: provider,
        registryProvider: provider,
        candidates: uniqueModelCandidates([modelId, modelId.replace(/\./g, "-")]),
      };
    default: {
      // Plugin providers register themselves in the AI registry; if they show
      // up there, treat them as direct providers without hard-coding here.
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

  const requestedCandidates = uniqueModelCandidates([
    args.fullModelId,
    ...directProvider.candidates,
  ]);

  const directModel = findRegistryModel(
    directProvider.registryProvider,
    requestedCandidates,
  );
  if (!directModel) {
    return null;
  }

  if (hasLocalProviderAuth(args.stellaRoot, directProvider.credentialProvider)) {
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

  if (directProvider.allowBaseUrlWithoutCredential && directModel.baseUrl) {
    return {
      model: directModel,
      route: "direct-provider",
      getApiKey: () => "",
    };
  }

  return null;
};

/**
 * Wrap any model id as a Stella-routed model id.
 *
 * `parsed.fullModelId` is the user-typed id minus surrounding whitespace,
 * already including its `<provider>/<model>` shape. We prefix `stella/` so the
 * Stella backend treats the rest as a passthrough to that upstream provider
 * (matching `parseStellaModelSelection` in `backend/convex/stella_models.ts`).
 */
const wrapAsStellaModelId = (fullModelId: string): string => {
  if (fullModelId.startsWith(`${STELLA_PROVIDER}/`)) return fullModelId;
  return `${STELLA_PROVIDER}/${fullModelId}`;
};

const resolveMaybeLlmRoute = (args: {
  stellaRoot: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
}): ResolvedLlmRoute | null => {
  const parsed = parseModelReference(args.modelName);

  // No model specified → Stella's recommended default.
  if (!parsed) {
    return createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: STELLA_DEFAULT_MODEL,
    });
  }

  // Explicit Stella prefix (`stella/<alias>` or `stella/<provider>/<model>`):
  // route through Stella with the original id intact.
  if (parsed.provider === STELLA_PROVIDER) {
    return createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: parsed.fullModelId,
    });
  }

  // Local API keys disabled → always go through Stella, wrapping the requested
  // provider/model so the Stella backend forwards it upstream.
  if (!isLocalLlmKeysEnabled(args.stellaRoot)) {
    return createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: wrapAsStellaModelId(parsed.fullModelId),
    });
  }

  // Local keys enabled: try the direct provider that the model id specifies.
  // Multiple authed providers can coexist; the model id is the source of truth.
  const directProviderRoute = resolveDirectProviderRoute({
    stellaRoot: args.stellaRoot,
    provider: parsed.provider,
    modelId: parsed.modelId,
    fullModelId: parsed.fullModelId,
  });
  if (directProviderRoute) {
    return directProviderRoute;
  }

  // No direct route (missing key or unknown provider) → fall back to Stella
  // rather than hard-failing. Users who want strict direct routing can add a
  // matching API key in Settings.
  return createStellaRoute({
    site: args.site,
    agentType: args.agentType,
    modelId: wrapAsStellaModelId(parsed.fullModelId),
  });
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
