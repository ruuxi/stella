import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAI } from "@ai-sdk/openai";
import { createGitLab } from "@gitlab/gitlab-ai-provider";
import { createGateway } from "ai";
import type { LanguageModel } from "ai";

/**
 * Creates a custom fetch wrapper that injects proxy auth for requests
 * to our Convex LLM proxy. ONLY adds auth for same-origin requests.
 */
function createProxyFetch(
  proxyBaseUrl: string,
  proxyToken: string,
  provider: string,
  modelId: string,
) {
  const proxyOrigin = new URL(proxyBaseUrl).origin;

  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const targetUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const target = new URL(targetUrl);

    if (target.origin === proxyOrigin) {
      const fullPath = target.pathname;
      const headers = new Headers(init?.headers);
      headers.set("X-Proxy-Token", proxyToken);
      headers.set("X-Provider", provider);
      headers.set("X-Original-Path", fullPath.replace(/^\/api\/ai\/llm-proxy\/?/, "/"));
      headers.set("X-Model-Id", modelId);

      const proxyUrl = `${proxyOrigin}/api/ai/llm-proxy`;
      return fetch(proxyUrl, { ...init, headers });
    }

    return fetch(url, init);
  };
}

export function createProxiedModel(
  proxyBaseUrl: string,
  proxyToken: string,
  modelId: string,
): LanguageModel {
  const provider = modelId.split("/")[0] ?? "anthropic";
  const modelName = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const customFetch = createProxyFetch(proxyBaseUrl, proxyToken, provider, modelId);

  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
      });
      return anthropic(modelName);
    }
    case "zenmux": {
      const anthropic = createAnthropic({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
      });
      return anthropic(modelName);
    }
    case "openai":
    case "openrouter":
    case "azure":
    case "azure-cognitive-services":
    case "cloudflare-workers-ai":
    case "cloudflare-ai-gateway":
    case "google-vertex":
    case "google-vertex-anthropic":
    case "vercel":
    case "cerebras":
    case "kilo":
    case "sap-ai-core":
    case "github-copilot":
    case "github-copilot-enterprise":
    case "opencode": {
      const openai = createOpenAI({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
      });
      return openai(modelName);
    }
    case "amazon-bedrock": {
      const bedrock = createAmazonBedrock({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
        region: process.env.AWS_REGION ?? "us-east-1",
      });
      return bedrock.languageModel(modelName);
    }
    case "gitlab": {
      const gitlab = createGitLab({
        instanceUrl: process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com",
        apiKey: "proxy-managed",
        aiGatewayHeaders: {
          "User-Agent": "stella",
        },
      });
      return gitlab.agenticChat(modelName);
    }
    case "moonshotai":
    case "zai":
    default: {
      const openai = createOpenAI({
        baseURL: `${proxyBaseUrl}/api/ai/llm-proxy`,
        fetch: customFetch,
        apiKey: "proxy-managed",
      });
      return openai(modelId);
    }
  }
}

/**
 * Creates a model using the Vercel AI Gateway directly.
 * Used when the raw proxy doesn't have provider API keys configured.
 */
export function createGatewayModel(
  gatewayApiKey: string,
  modelId: string,
): LanguageModel {
  const gateway = createGateway({ apiKey: gatewayApiKey });
  return gateway(modelId);
}
