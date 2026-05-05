import { Buffer } from "node:buffer";
import type { Model } from "../ai/types.js";
import {
  STELLA_DEFAULT_MODEL,
} from "../contracts/stella-api.js";
import { readConfiguredStellaSiteUrl } from "./convex-urls.js";
import type { ResolvedLlmRoute } from "./model-routing.js";

const STELLA_CONTEXT_WINDOW = 256_000;
const STELLA_MAX_TOKENS = 16_384;
const STELLA_AUTH_REFRESH_SKEW_MS = 15_000;
export const STELLA_PROVIDER = "stella";

export type StellaSiteConfig = {
  baseUrl: string | null;
  getAuthToken: () => string | null | undefined;
  refreshAuthToken?: () => Promise<string | null | undefined> | string | null | undefined;
};

const readJwtExpiryMs = (token: string): number | null => {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
};

const shouldRefreshToken = (token: string): boolean => {
  const expiresAtMs = readJwtExpiryMs(token);
  return expiresAtMs !== null && expiresAtMs <= Date.now() + STELLA_AUTH_REFRESH_SKEW_MS;
};

const createStellaModel = (
  siteBaseUrl: string,
  modelId: string,
  agentType: string,
): Model<"stella"> => ({
  id: modelId,
  name:
    modelId === STELLA_DEFAULT_MODEL
      ? "Stella Recommended"
      : modelId.replace(/^stella\//, ""),
  api: "stella",
  provider: STELLA_PROVIDER,
  baseUrl: siteBaseUrl,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: STELLA_CONTEXT_WINDOW,
  maxTokens: STELLA_MAX_TOKENS,
  headers: {
    "X-Stella-Agent-Type": agentType,
  },
});

export const normalizeStellaBase = readConfiguredStellaSiteUrl;

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

  const refreshApiKey = async (): Promise<string | undefined> => {
    const nextToken = (await args.site.refreshAuthToken?.())?.trim();
    return nextToken || undefined;
  };

  const getApiKey = async (): Promise<string | undefined> => {
    const currentToken = args.site.getAuthToken()?.trim() || authToken;
    if (currentToken && shouldRefreshToken(currentToken)) {
      return (await refreshApiKey()) || currentToken;
    }
    return currentToken || undefined;
  };

  return {
    route: "stella",
    model: createStellaModel(siteBaseUrl, args.modelId, args.agentType),
    getApiKey,
    refreshApiKey: args.site.refreshAuthToken ? refreshApiKey : undefined,
  };
};
