import type { Model } from "../ai/types.js";
import {
  normalizeStellaApiBaseUrl,
  STELLA_DEFAULT_MODEL,
} from "./stella-provider.js";
import { readConfiguredStellaBaseUrl } from "../../src/shared/lib/convex-urls.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

const STELLA_CONTEXT_WINDOW = 256_000;
const STELLA_MAX_TOKENS = 16_384;
export const STELLA_PROVIDER = "stella";

export type StellaSiteConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
};

const createStellaModel = (
  siteBaseUrl: string,
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
  baseUrl: normalizeStellaApiBaseUrl(siteBaseUrl),
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

export const normalizeStellaBase = readConfiguredStellaBaseUrl;

export const createStellaRoute = (args: {
  site: StellaSiteConfig;
  agentType: string;
  modelId: string;
}): ResolvedLlmRoute | null => {
  const siteBaseUrl = normalizeStellaBase(args.site.baseUrl);
  const authToken = args.site.getAuthToken()?.trim();
  if (!siteBaseUrl || !authToken) {
    return null;
  }

  return {
    route: "stella",
    model: createStellaModel(siteBaseUrl, args.modelId, args.agentType),
    getApiKey: () => args.site.getAuthToken()?.trim() || authToken,
  };
};
