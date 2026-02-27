/**
 * Model resolver — resolves per-agent model config with user overrides and BYOK support.
 *
 * Flow:
 * 1. Start with getModelConfig(agentType) defaults
 * 2. If ownerId provided, check user_preferences for model_config:{agentType} override
 * 3. If override found, replace model string
 * 4. If ownerId provided, check secrets for llm:{provider} API key
 * 5. If user key found, create direct provider model instance (bypass gateway)
 * 6. If no user key, return model string as-is (gateway resolves it)
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { createGitLab } from "@gitlab/gitlab-ai-provider";
import { createSAPAIProvider } from "@jerome-benoit/sap-ai-provider-v2";
import { createGateway, type LanguageModel } from "ai";
import { GoogleAuth } from "google-auth-library";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getModelConfig } from "./model";

export type ResolvedModelConfig = {
  model: string | LanguageModel;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
};

/** Extract provider prefix from a model string like "anthropic/claude-opus-4.6" */
function extractProvider(modelString: string): string | null {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return null;
  return modelString.slice(0, slash);
}

/** Extract model name after provider prefix */
function extractModelName(modelString: string): string {
  const slash = modelString.indexOf("/");
  if (slash <= 0) return modelString;
  return modelString.slice(slash + 1);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toGoogleAuthFetch(apiKey: string) {
  const parsed = parseJsonObject(apiKey);

  // Treat non-JSON keys as short-lived access tokens.
  if (!parsed) {
    const accessToken = apiKey.trim();
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers });
    };
  }

  const credentials = parsed;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const auth = new GoogleAuth({ credentials });
    const client = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    const accessToken =
      typeof tokenResult === "string"
        ? tokenResult
        : tokenResult?.token ?? null;
    if (!accessToken) {
      throw new Error("Google Vertex token exchange returned no access token");
    }
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(input, { ...init, headers });
  };
}

function buildBedrockModelId(modelName: string, region: string): string {
  const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."];
  if (crossRegionPrefixes.some((prefix) => modelName.startsWith(prefix))) {
    return modelName;
  }

  let regionPrefix = region.split("-")[0];
  let resolvedModel = modelName;

  switch (regionPrefix) {
    case "us": {
      const modelRequiresPrefix = [
        "nova-micro",
        "nova-lite",
        "nova-pro",
        "nova-premier",
        "nova-2",
        "claude",
        "deepseek",
      ].some((m) => modelName.includes(m));
      const isGovCloud = region.startsWith("us-gov");
      if (modelRequiresPrefix && !isGovCloud) {
        resolvedModel = `${regionPrefix}.${modelName}`;
      }
      break;
    }
    case "eu": {
      const regionRequiresPrefix = [
        "eu-west-1",
        "eu-west-2",
        "eu-west-3",
        "eu-north-1",
        "eu-central-1",
        "eu-south-1",
        "eu-south-2",
      ].some((r) => region.includes(r));
      const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
        modelName.includes(m),
      );
      if (regionRequiresPrefix && modelRequiresPrefix) {
        resolvedModel = `${regionPrefix}.${modelName}`;
      }
      break;
    }
    case "ap": {
      const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region);
      const isTokyoRegion = region === "ap-northeast-1";
      if (
        isAustraliaRegion &&
        ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelName.includes(m))
      ) {
        regionPrefix = "au";
        resolvedModel = `${regionPrefix}.${modelName}`;
      } else if (isTokyoRegion) {
        const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
          modelName.includes(m),
        );
        if (modelRequiresPrefix) {
          regionPrefix = "jp";
          resolvedModel = `${regionPrefix}.${modelName}`;
        }
      } else {
        const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
          modelName.includes(m),
        );
        if (modelRequiresPrefix) {
          regionPrefix = "apac";
          resolvedModel = `${regionPrefix}.${modelName}`;
        }
      }
      break;
    }
  }

  return resolvedModel;
}

/** Create a direct provider model instance for BYOK */
function createProviderModel(modelString: string, apiKey: string): LanguageModel | null {
  const provider = extractProvider(modelString);
  const modelName = extractModelName(modelString);

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName);
    }
    case "zenmux": {
      const zenmux = createAnthropic({
        apiKey,
        baseURL: "https://zenmux.ai/api/anthropic/v1",
      });
      return zenmux(modelName);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(modelName);
    }
    case "azure": {
      const resourceName = process.env.AZURE_RESOURCE_NAME?.trim();
      if (!resourceName) return null;
      const azure = createOpenAI({
        apiKey,
        baseURL: `https://${resourceName}.openai.azure.com/openai/v1`,
      });
      return azure(modelName);
    }
    case "azure-cognitive-services": {
      const resourceName = process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME?.trim();
      if (!resourceName) return null;
      const azureCognitive = createOpenAI({
        apiKey,
        baseURL: `https://${resourceName}.cognitiveservices.azure.com/openai/v1`,
      });
      return azureCognitive(modelName);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName);
    }
    case "cloudflare-workers-ai": {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
      if (!accountId) return null;
      const cloudflare = createOpenAI({
        apiKey,
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      });
      return cloudflare(modelName);
    }
    case "vercel": {
      const gateway = createGateway({ apiKey });
      return gateway(modelName);
    }
    case "cerebras": {
      const cerebras = createOpenAI({
        apiKey,
        baseURL: "https://api.cerebras.ai/v1",
        headers: {
          "X-Cerebras-3rd-Party-Integration": "stella",
        },
      });
      return cerebras(modelName);
    }
    case "kilo": {
      const kilo = createOpenAI({
        apiKey,
        baseURL: "https://api.kilo.ai/api/gateway",
        headers: {
          "HTTP-Referer": "https://stella.app/",
          "X-Title": "stella",
        },
      });
      return kilo(modelName);
    }
    case "cloudflare-ai-gateway": {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
      const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID?.trim();
      if (!accountId || !gatewayId) return null;
      const cloudflareGateway = createOpenAI({
        apiKey,
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`,
      });
      return cloudflareGateway(modelName);
    }
    case "github-copilot":
    case "github-copilot-enterprise": {
      const copilot = createOpenAI({
        apiKey,
        baseURL: "https://api.githubcopilot.com",
      });
      return copilot(modelName);
    }
    case "opencode": {
      const opencode = createOpenAI({
        apiKey,
        baseURL: "https://opencode.ai/zen/v1",
      });
      return opencode(modelName);
    }
    case "amazon-bedrock": {
      const parsed = parseJsonObject(apiKey);
      const regionFromKey =
        asNonEmptyString(parsed?.region) ??
        asNonEmptyString(parsed?.aws_region);
      const region = regionFromKey ?? process.env.AWS_REGION?.trim() ?? "us-east-1";

      const accessKeyId = asNonEmptyString(parsed?.accessKeyId) ?? asNonEmptyString(parsed?.aws_access_key_id);
      const secretAccessKey =
        asNonEmptyString(parsed?.secretAccessKey) ?? asNonEmptyString(parsed?.aws_secret_access_key);
      const sessionToken = asNonEmptyString(parsed?.sessionToken) ?? asNonEmptyString(parsed?.aws_session_token);
      const profile = asNonEmptyString(parsed?.profile) ?? process.env.AWS_PROFILE?.trim();

      const provider = createAmazonBedrock({
        region,
        ...(apiKey ? { apiKey } : {}),
        ...(accessKeyId && secretAccessKey
          ? {
              credentialProvider: async () => ({
                accessKeyId,
                secretAccessKey,
                ...(sessionToken ? { sessionToken } : {}),
              }),
            }
          : {
              credentialProvider: fromNodeProviderChain(profile ? { profile } : {}),
            }),
      });

      return provider.languageModel(buildBedrockModelId(modelName, region));
    }
    case "google-vertex": {
      const project =
        process.env.GOOGLE_VERTEX_PROJECT?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GCP_PROJECT?.trim() ||
        process.env.GCLOUD_PROJECT?.trim();
      if (!project) return null;

      const location =
        process.env.GOOGLE_VERTEX_LOCATION?.trim() ||
        process.env.GOOGLE_CLOUD_LOCATION?.trim() ||
        process.env.VERTEX_LOCATION?.trim() ||
        "us-central1";

      const vertex = createVertex({
        project,
        location,
        fetch: toGoogleAuthFetch(apiKey),
      });

      return vertex.languageModel(modelName.trim());
    }
    case "google-vertex-anthropic": {
      const project =
        process.env.GOOGLE_VERTEX_PROJECT?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        process.env.GCP_PROJECT?.trim() ||
        process.env.GCLOUD_PROJECT?.trim();
      if (!project) return null;

      const location =
        process.env.GOOGLE_VERTEX_LOCATION?.trim() ||
        process.env.GOOGLE_CLOUD_LOCATION?.trim() ||
        process.env.VERTEX_LOCATION?.trim() ||
        "global";

      const vertexAnthropic = createVertexAnthropic({
        project,
        location,
        fetch: toGoogleAuthFetch(apiKey),
      });

      return vertexAnthropic.languageModel(modelName.trim());
    }
    case "gitlab": {
      const instanceUrl = process.env.GITLAB_INSTANCE_URL?.trim() || "https://gitlab.com";
      const gitlab = createGitLab({
        instanceUrl,
        apiKey,
        aiGatewayHeaders: {
          "User-Agent": "stella",
        },
      });
      return gitlab.agenticChat(modelName);
    }
    case "sap-ai-core": {
      if (!process.env.AICORE_SERVICE_KEY?.trim()) {
        process.env.AICORE_SERVICE_KEY = apiKey;
      }
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID?.trim();
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP?.trim();
      const sap = createSAPAIProvider({
        ...(deploymentId ? { deploymentId } : {}),
        ...(resourceGroup ? { resourceGroup } : {}),
      });
      return sap(modelName);
    }
    default:
      return null;
  }
}

/** Create a model via OpenRouter (OpenAI-compatible API, any provider/model) */
function createOpenRouterModel(modelString: string, apiKey: string): LanguageModel {
  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  // OpenRouter accepts full provider/model strings as the model ID
  return openrouter(modelString);
}

/** Create a model via Vercel AI Gateway with user's own key */
function createGatewayModel(modelString: string, apiKey: string): LanguageModel {
  const gateway = createGateway({ apiKey });
  return gateway(modelString);
}

/** Strip gateway-specific options, keep provider-specific ones (e.g. openai.reasoningEffort) */
function filterGatewayOptions(
  providerOptions?: Record<string, unknown>,
): ProviderOptions | undefined {
  if (!providerOptions) return undefined;
  const { gateway, ...rest } = providerOptions;
  return Object.keys(rest).length > 0 ? (rest as ProviderOptions) : undefined;
}

/** Map provider prefix to secrets provider key */
function providerToSecretKey(provider: string): string | null {
  switch (provider) {
    case "anthropic":
      return "llm:anthropic";
    case "openai":
      return "llm:openai";
    case "google":
      return "llm:google";
    case "azure":
      return "llm:azure";
    case "azure-cognitive-services":
      return "llm:azure-cognitive-services";
    case "cloudflare-workers-ai":
      return "llm:cloudflare-workers-ai";
    case "vercel":
      return "llm:vercel";
    case "zenmux":
      return "llm:zenmux";
    case "cerebras":
      return "llm:cerebras";
    case "kilo":
      return "llm:kilo";
    case "amazon-bedrock":
      return "llm:amazon-bedrock";
    case "google-vertex":
      return "llm:google-vertex";
    case "google-vertex-anthropic":
      return "llm:google-vertex-anthropic";
    case "cloudflare-ai-gateway":
      return "llm:cloudflare-ai-gateway";
    case "gitlab":
      return "llm:gitlab";
    case "github-copilot":
      return "llm:github-copilot";
    case "github-copilot-enterprise":
      return "llm:github-copilot-enterprise";
    case "sap-ai-core":
      return "llm:sap-ai-core";
    case "opencode":
      return "llm:opencode";
    default:
      return null;
  }
}

/** Helper to look up a user's decrypted key for a given provider */
async function getUserKey(
  ctx: { runQuery: ActionCtx["runQuery"] },
  ownerId: string,
  provider: string,
): Promise<string | null> {
  return await ctx.runQuery(internal.data.secrets.getDecryptedLlmKey, {
    ownerId,
    provider,
  });
}

type ByokResolution = {
  model: string | LanguageModel;
  usedByok: boolean;
};

/** Resolve a model string through the BYOK chain, returning a model instance when a user key is available. */
async function resolveModelViaByokChain(
  ctx: { runQuery: ActionCtx["runQuery"] },
  ownerId: string,
  modelString: string,
): Promise<ByokResolution> {
  const provider = extractProvider(modelString);

  // 1. Direct provider key
  if (provider) {
    const secretKey = providerToSecretKey(provider);
    if (secretKey) {
      const apiKey = await getUserKey(ctx, ownerId, secretKey);
      if (apiKey) {
        const directModel = createProviderModel(modelString, apiKey);
        if (directModel) {
          return { model: directModel, usedByok: true };
        }
      }
    }
  }

  // 2. OpenRouter fallback
  const openrouterKey = await getUserKey(ctx, ownerId, "llm:openrouter");
  if (openrouterKey) {
    return {
      model: createOpenRouterModel(modelString, openrouterKey),
      usedByok: true,
    };
  }

  // 3. User's own Vercel AI Gateway key
  const gatewayKey = await getUserKey(ctx, ownerId, "llm:gateway");
  if (gatewayKey) {
    return {
      model: createGatewayModel(modelString, gatewayKey),
      usedByok: true,
    };
  }

  // 4. No BYOK — return model string (platform gateway will resolve it)
  return { model: modelString, usedByok: false };
}

/**
 * Resolve the model config for an agent type, applying user overrides and BYOK.
 *
 * - If no ownerId is provided, returns the default config (same as getModelConfig).
 * - If ownerId is provided, checks for a user model override preference.
 * - If the model's provider has a user-supplied API key, creates a direct provider instance.
 */
export async function resolveModelConfig(
  ctx: { runQuery: ActionCtx["runQuery"] },
  agentType: string,
  ownerId?: string,
): Promise<ResolvedModelConfig> {
  const defaults = getModelConfig(agentType);

  if (!ownerId) {
    return {
      model: defaults.model,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as ProviderOptions | undefined,
    };
  }

  // Check for user model override
  let modelString = defaults.model;
  const override = await ctx.runQuery(internal.data.preferences.getPreferenceForOwner, {
    ownerId,
    key: `model_config:${agentType}`,
  });
  if (override) {
    modelString = override;
  }

  const resolved = await resolveModelViaByokChain(ctx, ownerId, modelString);
  return {
    model: resolved.model,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: resolved.usedByok
      ? filterGatewayOptions(defaults.providerOptions as Record<string, unknown>)
      : (defaults.providerOptions as ProviderOptions | undefined),
  };
}

/**
 * Resolve a fallback model config for an agent type.
 *
 * Returns null if the agent has no fallback configured.
 * Uses the same BYOK chain as resolveModelConfig but with the fallback model string.
 * Temperature and maxOutputTokens are inherited from the primary config.
 */
export async function resolveFallbackConfig(
  ctx: { runQuery: ActionCtx["runQuery"] },
  agentType: string,
  ownerId?: string,
): Promise<ResolvedModelConfig | null> {
  const defaults = getModelConfig(agentType);
  if (!defaults.fallback) return null;

  const fallbackModel = defaults.fallback;

  if (!ownerId) {
    return {
      model: fallbackModel,
      temperature: defaults.temperature,
      maxOutputTokens: defaults.maxOutputTokens,
      providerOptions: defaults.providerOptions as ProviderOptions | undefined,
    };
  }

  const resolved = await resolveModelViaByokChain(ctx, ownerId, fallbackModel);
  return {
    model: resolved.model,
    temperature: defaults.temperature,
    maxOutputTokens: defaults.maxOutputTokens,
    providerOptions: resolved.usedByok
      ? filterGatewayOptions(defaults.providerOptions as Record<string, unknown>)
      : (defaults.providerOptions as ProviderOptions | undefined),
  };
}
