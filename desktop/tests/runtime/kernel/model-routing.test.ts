import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../runtime/ai/types.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

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
  getAllModels: () => [
    model("openai", "gpt-5.1-codex"),
    model("anthropic", "claude-opus-4.6"),
    model("openrouter", "anthropic/claude-opus-4.6"),
    model("vercel-ai-gateway", "openai/gpt-5.1-codex"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "openai":
        return [model("openai", "gpt-5.1-codex")];
      case "anthropic":
        return [model("anthropic", "claude-opus-4.6")];
      case "openrouter":
        return [model("openrouter", "anthropic/claude-opus-4.6")];
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

  it("falls back to Stella when no matching local credential is set for the chosen model", async () => {
    // No credentials saved at all → routing falls through to Stella with the
    // upstream provider/model preserved as a passthrough id.
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
    // Relay model carries the upstream provider so pi-mono adapters dispatch
    // correctly, but the id stays the original `stella/...` selection so
    // history replay and prompt-cache keys stay stable.
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.id).toBe("stella/openai/gpt-5.1-codex");
    expect(resolved.model.baseUrl).toBe(
      "https://stella.example.test/api/stella/openai/v1",
    );
  });

  it("uses Stella's recommended default when no model is specified", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.id).toBe("stella/default");
  });

  it("routes explicit `stella/<provider>/<model>` ids through Stella unchanged", async () => {
    credentials.set("anthropic", "anthropic-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "stella/anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.provider).toBe("anthropic");
    expect(resolved.model.id).toBe("stella/anthropic/claude-opus-4.6");
    expect(resolved.model.baseUrl).toBe(
      "https://stella.example.test/api/stella/anthropic",
    );
  });

  it("routes Stella aliases (stella/designer, etc.) through Stella unchanged", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "stella/designer",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.id).toBe("stella/designer");
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

  it("uses pushed Stella tokens without refreshing before the fallback window", async () => {
    const refreshAuthToken = vi.fn(async () => "fresh-stella-token");
    const currentToken = jwtWithExpiry(Date.now() + 30_000);
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site: {
        baseUrl: "https://stella.example.test",
        getAuthToken: () => currentToken,
        refreshAuthToken,
      },
    });

    expect(resolved.route).toBe("stella");
    await expect(resolved.getApiKey()).resolves.toBe(currentToken);
    expect(refreshAuthToken).not.toHaveBeenCalled();
  });

  it("routes by parsed provider id when a matching local credential exists", async () => {
    credentials.set("anthropic", "anthropic-key");
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
    expect(resolved.model.id).toBe("claude-opus-4.6");
    await expect(resolved.getApiKey()).resolves.toBe("anthropic-key");
  });

  it("honors multiple authed providers — each model id picks its own credential", async () => {
    credentials.set("anthropic", "anthropic-key");
    credentials.set("openai", "openai-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const anthropicRoute = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });
    expect(anthropicRoute.model.provider).toBe("anthropic");
    await expect(anthropicRoute.getApiKey()).resolves.toBe("anthropic-key");

    const openaiRoute = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site,
    });
    expect(openaiRoute.model.provider).toBe("openai");
    await expect(openaiRoute.getApiKey()).resolves.toBe("openai-key");
  });

  it("does not silently re-route to a different provider's gateway", async () => {
    // User has only an OpenRouter key, but asks for `anthropic/...` directly.
    // Old behavior would remap through OpenRouter; new behavior falls back to
    // Stella so the user-typed provider id is never silently substituted.
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.id).toBe("stella/anthropic/claude-opus-4.6");
  });

  it("routes explicit `openrouter/<provider>/<model>` through OpenRouter directly", async () => {
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "openrouter/anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("anthropic/claude-opus-4.6");
    await expect(resolved.getApiKey()).resolves.toBe("openrouter-key");
  });

  it("falls back to Stella when the requested provider has no credential", async () => {
    credentials.set("anthropic", "anthropic-key");
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
    expect(resolved.model.provider).toBe("openai");
    expect(resolved.model.id).toBe("stella/openai/gpt-5.1-codex");
    expect(resolved.model.baseUrl).toBe(
      "https://stella.example.test/api/stella/openai/v1",
    );
  });

  it("uses OAuth credentials when no API key is set for the requested provider", async () => {
    oauthCredentials.add("anthropic");
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

  it("routes local OpenAI-compatible models directly without credentials", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: "local/llama3.2",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("local");
    expect(resolved.model.id).toBe("llama3.2");
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(await Promise.resolve(resolved.getApiKey())).toBe("");
  });

  it("routes local OpenAI-compatible models with a custom base URL", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaRoot: "/tmp/stella",
      modelName: `local/${encodeURIComponent("http://127.0.0.1:8000/v1")}/qwen3-coder`,
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("local");
    expect(resolved.model.id).toBe("qwen3-coder");
    expect(resolved.model.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(await Promise.resolve(resolved.getApiKey())).toBe("");
  });
});
