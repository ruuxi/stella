import { Buffer } from "node:buffer";
import type { Api, Model } from "../ai/types.js";
import {
  findRegistryModel,
  findRegistryModelsById,
  getStellaVerbatimUpstreamModel,
  uniqueModelCandidates,
} from "./model-routing-matching.js";
import {
  STELLA_DEFAULT_MODEL,
  STELLA_RELAY_PROVIDERS,
  STELLA_STANDARD_MODEL,
  stellaManagedRelayBaseUrlFromSiteUrl,
  type StellaRelayProvider,
} from "../contracts/stella-api.js";
import { readConfiguredStellaSiteUrl } from "./convex-urls.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

/**
 * Fallback context window for Stella-managed relay routes, used only when the
 * resolved upstream model isn't found in the registry. When the model *is* in
 * the registry, `createRelayModel` carries its real provider-catalog-derived
 * context window instead — which the orchestrator compaction trigger keys off.
 */
export const STELLA_CONTEXT_WINDOW = 80_000;
const STELLA_MAX_TOKENS = 16_384;
const STELLA_AUTH_REFRESH_SKEW_MS = 15_000;
export const STELLA_PROVIDER = "stella";

export type StellaSiteConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
  refreshAuthToken?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  hasConnectedAccount?: () => boolean;
};

type ManagedGatewayProvider = StellaRelayProvider;

const STELLA_REGISTRY_PROVIDERS = new Set<string>(STELLA_RELAY_PROVIDERS);

const FIREWORKS_MODEL_PREFIXES = [
  "accounts/fireworks/models/",
  "accounts/fireworks/routers/",
] as const;

const DIRECT_MODEL_PROVIDER_PREFIXES = [
  ["openai/", "openai"],
  ["anthropic/", "anthropic"],
  ["google/", "google"],
] as const satisfies readonly (readonly [string, ManagedGatewayProvider])[];

export const inferManagedGatewayProviderFromModel = (
  model: string,
): ManagedGatewayProvider => {
  const directProvider = DIRECT_MODEL_PROVIDER_PREFIXES.find(([prefix]) =>
    model.startsWith(prefix),
  )?.[1];
  if (directProvider) return directProvider;
  if (FIREWORKS_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return "fireworks";
  }
  return "openrouter";
};

export const resolveManagedStellaRegistryMatches = (
  matches: ReturnType<typeof findRegistryModelsById>,
): string | null => {
  const eligibleMatches = matches.filter(({ registryProvider }) =>
    STELLA_REGISTRY_PROVIDERS.has(registryProvider),
  );
  if (eligibleMatches.length === 0) return null;

  const candidates = eligibleMatches.flatMap(({ registryProvider, model }) => {
    switch (registryProvider) {
      case "openai":
      case "anthropic":
      case "google":
      case "openrouter":
        return [`${registryProvider}/${model.id}`];
      case "fireworks":
        return model.id.startsWith("accounts/fireworks/") ? [model.id] : [];
      default:
        return [];
    }
  });
  const uniqueCandidates = Array.from(new Set(candidates));
  return candidates.length === eligibleMatches.length &&
    uniqueCandidates.length === 1
    ? uniqueCandidates[0]
    : null;
};

const managedUpstreamForBareStellaModel = (
  bareModelId: string,
): string | null => {
  const matches = findRegistryModelsById(bareModelId);
  // Opaque backend-owned aliases are not in the local registry. Preserve the
  // exact id as a provisional route so catalog enrichment can resolve it; if
  // the catalog is unavailable, the relay sees that exact id and fails loudly
  // upstream instead of silently substituting another model family.
  if (matches.length === 0) return bareModelId;

  return resolveManagedStellaRegistryMatches(matches);
};

export const resolveOfflineStellaModelId = (modelId: string): string | null => {
  // Offline fallback for the per-mode upstream model when the server catalog
  // metadata is unavailable. Keep in sync with the backend `BASE_MODE_CONFIGS`
  // (convex/agent/model.ts) — the catalog is the source of truth at runtime.
  switch (modelId) {
    case "stella/light":
      return "accounts/fireworks/models/deepseek-v4-flash";
    case "stella/priority":
      return "accounts/fireworks/models/kimi-k2p7-code";
    case "stella/builder":
      return "openai/gpt-5.5";
    case "stella/designer":
      return "anthropic/claude-opus-4.8";
    case "stella/vision":
      return "google/gemini-3-flash-preview";
    case "stella/max":
      return "anthropic/claude-fable-5";
    case STELLA_STANDARD_MODEL:
      return "meta/muse-spark-1.1";
    case STELLA_DEFAULT_MODEL:
      return "openrouter/x-ai/grok-4.5";
    default: {
      const upstream = getStellaVerbatimUpstreamModel(modelId);
      if (upstream) return upstream;
      const barePrefix = `${STELLA_PROVIDER}/`;
      if (modelId.startsWith(barePrefix)) {
        return managedUpstreamForBareStellaModel(
          modelId.slice(barePrefix.length),
        );
      }
      return null;
    }
  }
};

const readJwtExpiryMs = (token: string): number | null => {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
};

const shouldRefreshToken = (token: string): boolean => {
  const expiresAtMs = readJwtExpiryMs(token);
  return (
    expiresAtMs !== null &&
    expiresAtMs <= Date.now() + STELLA_AUTH_REFRESH_SKEW_MS
  );
};

const modelName = (modelId: string): string => modelId.replace(/^stella\//, "");

const providerNativeModelId = (
  resolvedModelId: string,
  provider: ManagedGatewayProvider,
): string => {
  if (
    (provider === "openai" ||
      provider === "anthropic" ||
      provider === "google") &&
    resolvedModelId.startsWith(`${provider}/`)
  ) {
    return resolvedModelId.slice(provider.length + 1);
  }
  return resolvedModelId;
};

const registryProviderForRelay = (provider: ManagedGatewayProvider): string =>
  provider === "fireworks" ? "fireworks" : provider;

const apiForRelay = (
  provider: ManagedGatewayProvider,
  registryModel: Model<Api> | null,
): Api => {
  if (registryModel?.api) return registryModel.api;
  switch (provider) {
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "openai":
    case "fireworks":
      return "openai-responses";
    case "openrouter":
      return "openai-completions";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const createRelayModel = (args: {
  siteBaseUrl: string;
  requestedModelId: string;
  resolvedModelId: string;
  provider: ManagedGatewayProvider;
  agentType: string;
  authToken: string;
}): Model<Api> => {
  const nativeId = providerNativeModelId(args.resolvedModelId, args.provider);
  const registryModel = findRegistryModel(
    registryProviderForRelay(args.provider),
    uniqueModelCandidates([
      args.resolvedModelId,
      nativeId,
      nativeId.replace(/\./g, "-"),
    ]),
  );

  const model = {
    ...(registryModel ?? {
      id: nativeId,
      name: nativeId,
      provider: args.provider,
      api: apiForRelay(args.provider, null),
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: STELLA_CONTEXT_WINDOW,
      maxTokens: STELLA_MAX_TOKENS,
    }),
    id: args.requestedModelId,
    name: modelName(args.requestedModelId),
    provider: registryModel?.provider ?? args.provider,
    api: apiForRelay(args.provider, registryModel),
    baseUrl: stellaManagedRelayBaseUrlFromSiteUrl(args.siteBaseUrl),
    headers: {
      ...(registryModel?.headers ?? {}),
      // `X-Stella-Agent-Type` lets the relay attribute usage to the
      // right per-agent bucket. The relay strips this header before
      // forwarding upstream. The previous `X-Stella-Relay: 1` sentinel
      // is gone — provider adapters now detect the relay by baseUrl
      // (so a missing header can never accidentally route native auth
      // headers through to providers that wouldn't accept Stella's
      // token shape).
      "X-Stella-Agent-Type": args.agentType,
    },
  } as Model<Api>;

  // Stash the resolved upstream model id so provider adapters can make
  // model-capability decisions (e.g. Anthropic adaptive vs budget-based
  // thinking, which Opus 4.7 rejects in budget form) when `model.id`
  // carries a user-facing Stella alias like `stella/designer` that doesn't
  // include the underlying model slug.
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    nativeId;
  return model;
};

export const normalizeStellaBase = readConfiguredStellaSiteUrl;

export const createStellaRoute = (args: {
  site: StellaSiteConfig;
  agentType: string;
  modelId: string;
  resolvedModelId?: string;
}): ResolvedLlmRoute | null => {
  const siteBaseUrl = normalizeStellaBase(args.site.baseUrl);
  const authToken = args.site.getAuthToken()?.trim();
  const canRefreshMissingToken =
    Boolean(args.site.refreshAuthToken) &&
    args.site.hasConnectedAccount?.() === true;
  if (!siteBaseUrl || (!authToken && !canRefreshMissingToken)) {
    return null;
  }

  const resolvedModelId =
    args.resolvedModelId ?? resolveOfflineStellaModelId(args.modelId);
  if (!resolvedModelId) return null;
  const relayProvider = inferManagedGatewayProviderFromModel(resolvedModelId);

  const refreshApiKey = async (): Promise<string | undefined> => {
    const nextToken = (await args.site.refreshAuthToken?.())?.trim();
    return nextToken || undefined;
  };

  const getApiKey = async (): Promise<string | undefined> => {
    const currentToken = args.site.getAuthToken()?.trim() || authToken;
    if (currentToken && shouldRefreshToken(currentToken)) {
      return (await refreshApiKey()) || currentToken;
    }
    return currentToken || (await refreshApiKey()) || undefined;
  };

  return {
    route: "stella",
    model: createRelayModel({
      siteBaseUrl,
      requestedModelId: args.modelId,
      resolvedModelId,
      provider: relayProvider,
      agentType: args.agentType,
      authToken: authToken || "",
    }),
    getApiKey,
    refreshApiKey: args.site.refreshAuthToken ? refreshApiKey : undefined,
  };
};
