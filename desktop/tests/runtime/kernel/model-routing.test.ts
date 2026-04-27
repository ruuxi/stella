import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../runtime/ai/types.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();
let localPreference = { enabled: false, provider: "openai" };

vi.mock("../../../../runtime/kernel/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: (_stellaRoot: string, provider: string) =>
    credentials.get(provider) ?? null,
}));

vi.mock("../../../../runtime/kernel/storage/llm-oauth-credentials.js", () => ({
  hasLocalLlmOAuthCredential: (_stellaRoot: string, provider: string) =>
    oauthCredentials.has(provider),
  getLocalLlmOAuthApiKey: async (_stellaRoot: string, provider: string) =>
    oauthCredentials.has(provider) ? `${provider}-oauth-token` : null,
}));

vi.mock("../../../../runtime/kernel/preferences/local-preferences.js", () => ({
  getLocalLlmProviderPreference: () => localPreference,
}));

const model = (
  provider: string,
  id: string,
  api = "openai-completions",
): Model<any> => ({
  id,
  name: id,
  api: api as never,
  provider: provider as never,
  baseUrl: `https://${provider}.example.test`,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

vi.mock("../../../../runtime/ai/models.js", () => ({
  getModels: (provider: string) => {
    switch (provider) {
      case "openai":
        return [model("openai", "gpt-5.1-codex")];
      case "anthropic":
        return [model("anthropic", "claude-opus-4.6")];
      case "openrouter":
        return [model("openrouter", "openai/gpt-5.1-codex")];
      case "vercel-ai-gateway":
        return [model("vercel-ai-gateway", "openai/gpt-5.1-codex")];
      default:
        return [];
    }
  },
}));

describe("resolveLlmRoute", () => {
  beforeEach(() => {
    credentials.clear();
    oauthCredentials.clear();
    localPreference = { enabled: false, provider: "openai" };
  });

  const site = {
    baseUrl: "https://stella.example.test",
    getAuthToken: () => "stella-token",
  };

  const jwtWithExpiry = (expiresAtMs: number) => {
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) }),
    ).toString("base64url");
    return `header.${payload}.signature`;
  };

  it("uses Stella when local API key usage is off even if matching keys exist", async () => {
    credentials.set("openai", "openai-key");
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.provider).toBe("stella");
    expect(resolved.model.id).toBe("stella/openai/gpt-5.1-codex");
  });

  it("refreshes near-expiry Stella tokens before model calls", async () => {
    const refreshAuthToken = vi.fn(async () => "fresh-stella-token");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site: {
        baseUrl: "https://stella.example.test",
        getAuthToken: () => jwtWithExpiry(Date.now() + 10_000),
        refreshAuthToken,
      },
    });

    expect(resolved.route).toBe("stella");
    await expect(resolved.getApiKey()).resolves.toBe("fresh-stella-token");
    expect(refreshAuthToken).toHaveBeenCalledTimes(1);
  });

  it("uses the selected local provider when local API key usage is enabled", async () => {
    credentials.set("openrouter", "openrouter-key");
    localPreference = { enabled: true, provider: "openrouter" };
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("openai/gpt-5.1-codex");
    await expect(resolved.getApiKey()).resolves.toBe("openrouter-key");
  });

  it("falls back to Stella instead of trying unselected saved providers", async () => {
    credentials.set("openrouter", "openrouter-key");
    localPreference = { enabled: true, provider: "openai" };
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.provider).toBe("stella");
  });

  it("uses OAuth credentials for the selected local provider", async () => {
    oauthCredentials.add("anthropic");
    localPreference = { enabled: true, provider: "anthropic" };
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("anthropic");
    await expect(resolved.getApiKey()).resolves.toBe("anthropic-oauth-token");
  });
});
