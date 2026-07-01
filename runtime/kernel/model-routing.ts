import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "../ai/types.js";
import { AGENT_IDS } from "../contracts/agent-runtime.js";
import { getModels } from "../ai/models.js";
import {
  formatLlmRouteFailure,
  type LlmRouteFailure,
} from "../ai/llm-route-failure.js";
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

export type ResolvedLlmRoute = {
  model: Model<Api>;
  toolPolicyModel?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
  route: "direct-provider" | "stella";
  getApiKey: () => Promise<string | undefined> | string | undefined;
  refreshApiKey?: () => Promise<string | undefined> | string | undefined;
};

const LOCAL_PROVIDER = "local";
const DEFAULT_LOCAL_OPENAI_BASE_URL = "http://127.0.0.1:11434/v1";
const GROK_PROVIDER = "grok";
const GROK_COMPOSER_MODEL = "grok-composer-2.5-fast";

const readGrokCliSessionToken = (): string | undefined => {
  const authPath =
    process.env.GROK_AUTH_PATH?.trim() ||
    path.join(
      process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok"),
      "auth.json",
    );
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      { key?: unknown }
    >;
    for (const value of Object.values(parsed)) {
      if (typeof value?.key === "string" && value.key.trim()) {
        return value.key.trim();
      }
    }
  } catch {
    // Missing or corrupt Grok auth means this route is unavailable.
  }
  return undefined;
};

const createLocalOpenAICompatibleModel = (
  modelId: string,
  baseUrl = DEFAULT_LOCAL_OPENAI_BASE_URL,
): Model<"openai-completions"> => ({
  id: modelId,
  name: modelId,
  api: "openai-completions",
  provider: LOCAL_PROVIDER,
  baseUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  },
});

const parseLocalModelId = (
  rawModelId: string,
): { modelId: string; baseUrl: string } | null => {
  const trimmed = rawModelId.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    let maybeBaseUrl: string;
    try {
      maybeBaseUrl = decodeURIComponent(trimmed.slice(0, slash));
    } catch {
      maybeBaseUrl = "";
    }
    const modelId = trimmed.slice(slash + 1).trim();
    if (/^https?:\/\//i.test(maybeBaseUrl) && modelId) {
      return {
        modelId,
        baseUrl: maybeBaseUrl,
      };
    }
  }

  return {
    modelId: trimmed,
    baseUrl: DEFAULT_LOCAL_OPENAI_BASE_URL,
  };
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
  resolved.route === "direct-provider" &&
  resolved.model.baseUrl.trim().length > 0;

const getCredential = (stellaAppDir: string, providerId: string): string | null =>
  getLocalLlmCredential(stellaAppDir, providerId);

const hasLocalProviderAuth = (
  stellaAppDir: string,
  providerId: string,
): boolean =>
  Boolean(getCredential(stellaAppDir, providerId)) ||
  hasLocalLlmOAuthCredential(stellaAppDir, providerId);

const getLocalProviderApiKey = async (
  stellaAppDir: string,
  providerId: string,
): Promise<string | undefined> => {
  const apiKey = getCredential(stellaAppDir, providerId)?.trim();
  if (apiKey) return apiKey;
  const oauthKey = (
    await getLocalLlmOAuthApiKey(stellaAppDir, providerId)
  )?.trim();
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
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
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
    case GROK_PROVIDER:
    case "xai":
    case "zai":
    case "openrouter":
    case "vercel-ai-gateway":
      return {
        credentialProvider: provider,
        registryProvider: provider,
        candidates: uniqueModelCandidates([
          modelId,
          modelId.replace(/\./g, "-"),
        ]),
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
          candidates: uniqueModelCandidates([
            modelId,
            modelId.replace(/\./g, "-"),
          ]),
        };
      }
      return null;
    }
  }
};

/**
 * Pass-through gateways whose model-id space is owned by the gateway, not our
 * static registry. The gateway accepts arbitrary `<vendor>/<model>` ids as-is
 * and normalizes transport/quirks, so we can synthesize a routable model from
 * the gateway's registry template when the (best-effort, network-bound)
 * models.dev fetch hasn't populated the exact id yet. This keeps the model
 * picker (which fetches models.dev live) and the runtime resolver from
 * disagreeing. The gateway remains the authority — a bogus id fails loudly
 * upstream, not here.
 *
 * Direct vendor providers (Anthropic, OpenAI, …) are intentionally excluded:
 * their id formats are quirk-specific (dashes, date suffixes) and encoded
 * precisely in the static registry, so synthesizing one risks a malformed id.
 */
const SYNTHESIZABLE_GATEWAY_PROVIDERS = new Set<string>([
  "openrouter",
  "vercel-ai-gateway",
]);

/**
 * Floor for the context window of a synthesized gateway model. The template
 * we clone is an arbitrary registry entry (whichever sorts first), so its
 * window says nothing about the actual model; a small inherited value would
 * make compaction/overflow logic truncate history far too early.
 */
const SYNTHESIZED_GATEWAY_CONTEXT_WINDOW_FLOOR = 200_000;

/**
 * Build a routable model for `modelId` by cloning the gateway's registry
 * template — which carries the `api`, `baseUrl`, `headers`, and `compat`
 * needed to actually make the request, none of which models.dev provides.
 * Cost metadata falls back to the template's values; the request still
 * succeeds and the gateway validates the id.
 *
 * Output/context limits are intentionally NOT inherited: the template is an
 * arbitrary registry entry whose `maxTokens` may be tiny (e.g. 4096), and
 * `buildBaseOptions` turns `model.maxTokens` into a hard `max_tokens` cap on
 * every request. For a reasoning model that cap can be consumed entirely by
 * thinking, truncating the run before any visible text is produced. Setting
 * `maxTokens: 0` makes `buildBaseOptions` omit the cap and lets the gateway
 * (which owns the id space) enforce the model's real limit.
 */
const synthesizeGatewayModelFromTemplate = (
  registryProvider: string,
  modelId: string,
): Model<Api> | null => {
  if (!SYNTHESIZABLE_GATEWAY_PROVIDERS.has(registryProvider)) return null;
  const template = (getModels(registryProvider as never) as Model<Api>[])[0];
  if (!template) return null;
  return {
    ...template,
    id: modelId,
    name: modelId,
    maxTokens: 0,
    contextWindow: Math.max(
      template.contextWindow,
      SYNTHESIZED_GATEWAY_CONTEXT_WINDOW_FLOOR,
    ),
  };
};

/**
 * Outcome of trying to satisfy an explicit direct-provider (BYOK / local)
 * selection. Every non-route outcome names *why* it failed so the caller can
 * surface a specific, actionable message instead of silently re-routing.
 */
type DirectProviderRouteResult =
  | { kind: "route"; route: ResolvedLlmRoute }
  // The `<provider>/` prefix isn't a provider Stella can talk to directly.
  | { kind: "unsupported-provider" }
  // Provider is known but the model id isn't in its registry (typo / dropped).
  | { kind: "unknown-model" }
  // Provider + model are valid, but there's no usable key/credential for it.
  | { kind: "missing-credential" };

const resolveDirectProviderRoute = (args: {
  stellaAppDir: string;
  provider: string;
  modelId: string;
  fullModelId: string;
}): DirectProviderRouteResult => {
  if (args.provider === LOCAL_PROVIDER && args.modelId.trim()) {
    const local = parseLocalModelId(args.modelId);
    if (!local) return { kind: "unknown-model" };
    return {
      kind: "route",
      route: {
        model: createLocalOpenAICompatibleModel(local.modelId, local.baseUrl),
        route: "direct-provider",
        getApiKey: () => "",
      },
    };
  }

  const directProvider = getDirectProviderCandidates(
    args.provider,
    args.modelId,
  );
  if (!directProvider) {
    return { kind: "unsupported-provider" };
  }

  const requestedCandidates = uniqueModelCandidates([
    args.fullModelId,
    ...directProvider.candidates,
  ]);

  const directModel =
    findRegistryModel(directProvider.registryProvider, requestedCandidates) ??
    synthesizeGatewayModelFromTemplate(
      directProvider.registryProvider,
      args.modelId,
    );
  if (!directModel) {
    return { kind: "unknown-model" };
  }

  if (
    args.provider === GROK_PROVIDER &&
    directModel.id === GROK_COMPOSER_MODEL
  ) {
    return {
      kind: "route",
      route: {
        model: directModel,
        route: "direct-provider",
        getApiKey: () => readGrokCliSessionToken(),
      },
    };
  }

  if (
    hasLocalProviderAuth(args.stellaAppDir, directProvider.credentialProvider)
  ) {
    return {
      kind: "route",
      route: {
        model: directModel,
        route: "direct-provider",
        getApiKey: () =>
          getLocalProviderApiKey(
            args.stellaAppDir,
            directProvider.credentialProvider,
          ),
      },
    };
  }

  if (directProvider.allowBaseUrlWithoutCredential && directModel.baseUrl) {
    return {
      kind: "route",
      route: {
        model: directModel,
        route: "direct-provider",
        getApiKey: () => "",
      },
    };
  }

  return { kind: "missing-credential" };
};

type LlmRouteResolution =
  | { ok: true; route: ResolvedLlmRoute }
  | { ok: false; failure: LlmRouteFailure };

const resolveLlmRouteResult = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
}): LlmRouteResolution => {
  const parsed = parseModelReference(args.modelName);

  // No model specified → let the backend choose from agent type + audience.
  if (!parsed) {
    const route = createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: STELLA_DEFAULT_MODEL,
    });
    return route
      ? { ok: true, route }
      : { ok: false, failure: { kind: "no-stella-route" } };
  }

  // Explicit Stella prefix (`stella/<alias>` or `stella/<provider>/<model>`):
  // route through Stella with the original id intact.
  if (parsed.provider === STELLA_PROVIDER) {
    const route = createStellaRoute({
      site: args.site,
      agentType: args.agentType,
      modelId: parsed.fullModelId,
    });
    return route
      ? { ok: true, route }
      : { ok: false, failure: { kind: "no-stella-route" } };
  }

  // Explicit non-Stella selection (BYOK / local / direct provider): the model
  // id is the source of truth and must be honored exactly. We never silently
  // re-route a user's explicit provider pick through Stella's managed gateway —
  // that would swap their provider, billing, and sometimes the model itself
  // without consent. Any failure is reported so the caller can fail loudly and
  // let the user switch models.
  const direct = resolveDirectProviderRoute({
    stellaAppDir: args.stellaAppDir,
    provider: parsed.provider,
    modelId: parsed.modelId,
    fullModelId: parsed.fullModelId,
  });
  if (direct.kind === "route") {
    return { ok: true, route: direct.route };
  }
  // The three non-route outcomes all carry the same context; `direct.kind`
  // (`unsupported-provider` | `unknown-model` | `missing-credential`) maps 1:1
  // onto the failure kind.
  return {
    ok: false,
    failure: {
      kind: direct.kind,
      provider: parsed.provider,
      model: parsed.fullModelId,
    },
  };
};

export const canResolveLlmRoute = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType?: string;
  site: StellaSiteConfig;
}): boolean => {
  const agentType = args.agentType ?? AGENT_IDS.ORCHESTRATOR;
  const result = resolveLlmRouteResult({ ...args, agentType });
  if (result.ok) return true;

  // An unhonorable explicit model pick does NOT make the orchestrator unready:
  // the run still starts and surfaces a toast for the bad pick, then the user
  // switches models. Readiness only fails when there's no route at all — i.e.
  // no Stella account to run anything on.
  if (result.failure.kind === "no-stella-route") {
    return false;
  }
  return Boolean(
    createStellaRoute({
      site: args.site,
      agentType,
      modelId: STELLA_DEFAULT_MODEL,
    }),
  );
};

export const resolveLlmRoute = (args: {
  stellaAppDir: string;
  modelName: string | undefined;
  agentType: string;
  site: StellaSiteConfig;
}): ResolvedLlmRoute => {
  const result = resolveLlmRouteResult(args);
  if (result.ok) return result.route;
  throw new Error(formatLlmRouteFailure(result.failure));
};
