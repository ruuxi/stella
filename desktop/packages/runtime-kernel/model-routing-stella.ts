import type { Model } from "../ai/types.js";
import { normalizeStellaApiBaseUrl, STELLA_DEFAULT_MODEL } from "./stella-provider.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

const STELLA_CONTEXT_WINDOW = 256_000;
const STELLA_MAX_TOKENS = 16_384;
export const STELLA_PROVIDER = "stella";

export type StellaProxyConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
};

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

export const normalizeStellaBase = (
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

export const createStellaRoute = (args: {
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
