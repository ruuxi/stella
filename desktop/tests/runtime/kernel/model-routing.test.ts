import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../runtime/ai/types.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

vi.mock("../../../../runtime/kernel/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: (_stellaAppDir: string, provider: string) =>
    credentials.get(provider) ?? null,
}));

vi.mock("../../../../runtime/kernel/storage/llm-oauth-credentials.js", () => ({
  hasLocalLlmOAuthCredential: (_stellaAppDir: string, provider: string) =>
    oauthCredentials.has(provider),
  getLocalLlmOAuthApiKey: async (_stellaAppDir: string, provider: string) =>
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

  it("fails loudly (no Stella fallback) when an explicit BYOK model has no key", async () => {
    // The user explicitly picked an OpenAI model but saved no OpenAI key. We
    // must NOT silently re-route through Stella's managed gateway — surface a
    // clear error so the caller can toast and the user can switch models.
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      }),
    ).toThrow(/no usable api key for openai/i);
  });

  it("uses Stella's backend default sentinel when no model is specified", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.id).toBe("stella/default");
    expect(resolved.model.provider).toBe("openai");
  });

  it("routes explicit `stella/<provider>/<model>` ids through Stella unchanged", async () => {
    credentials.set("anthropic", "anthropic-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("stella");
    expect(resolved.model.provider).toBe("anthropic");
    expect(resolved.model.id).toBe("stella/anthropic/claude-opus-4.6");
    expect(resolved.model.baseUrl).toBe(
      "https://stella.example.test/api/stella/relay",
    );
  });

  it("routes Stella aliases (stella/designer, etc.) through Stella unchanged", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
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
      stellaAppDir: "/tmp/stella",
      modelName: "stella/default",
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
      stellaAppDir: "/tmp/stella",
      modelName: "stella/default",
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
      stellaAppDir: "/tmp/stella",
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
      stellaAppDir: "/tmp/stella",
      modelName: "anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });
    expect(anthropicRoute.model.provider).toBe("anthropic");
    await expect(anthropicRoute.getApiKey()).resolves.toBe("anthropic-key");

    const openaiRoute = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      site,
    });
    expect(openaiRoute.model.provider).toBe("openai");
    await expect(openaiRoute.getApiKey()).resolves.toBe("openai-key");
  });

  it("never silently substitutes another provider; it fails loudly", async () => {
    // User has only an OpenRouter key but explicitly asks for `anthropic/...`.
    // We must not remap through OpenRouter OR Stella — the selection fails
    // loudly so the user can add an Anthropic key or switch models.
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "anthropic/claude-opus-4.6",
        agentType: "general",
        site,
      }),
    ).toThrow(/no usable api key for anthropic/i);
  });

  it("routes explicit `openrouter/<provider>/<model>` through OpenRouter directly", async () => {
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "openrouter/anthropic/claude-opus-4.6",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("anthropic/claude-opus-4.6");
    await expect(resolved.getApiKey()).resolves.toBe("openrouter-key");
  });

  it("fails loudly when the requested provider has no credential (other providers authed)", async () => {
    credentials.set("anthropic", "anthropic-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      }),
    ).toThrow(/no usable api key for openai/i);
  });

  it("synthesizes a route for an unregistered id on a pass-through gateway", async () => {
    // The model picker fetches models.dev live and may show an OpenRouter id
    // the runtime registry hasn't picked up yet. Rather than failing, we clone
    // the OpenRouter template and let OpenRouter validate the id upstream.
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "openrouter/anthropic/claude-opus-9.9",
      agentType: "general",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("openrouter");
    expect(resolved.model.id).toBe("anthropic/claude-opus-9.9");
    await expect(resolved.getApiKey()).resolves.toBe("openrouter-key");
  });

  it("does not inherit the template's output/context limits when synthesizing", async () => {
    // The cloned template is an arbitrary registry entry; its maxTokens can be
    // tiny (4096 for some entries). buildBaseOptions turns model.maxTokens
    // into a hard max_tokens cap per request, which a reasoning model can
    // exhaust entirely on thinking — the run then truncates with no visible
    // reply. Synthesized gateway models must send no cap (maxTokens: 0) and
    // keep a generous context window so compaction doesn't fire early.
    credentials.set("openrouter", "openrouter-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "openrouter/anthropic/claude-opus-9.9",
      agentType: "general",
      site,
    });

    expect(resolved.model.maxTokens).toBe(0);
    expect(resolved.model.contextWindow).toBeGreaterThanOrEqual(200_000);
  });

  it("still requires a key for a synthesized gateway model", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openrouter/anthropic/claude-opus-9.9",
        agentType: "general",
        site,
      }),
    ).toThrow(/no usable api key for openrouter/i);
  });

  it("fails loudly for an unknown model id on a non-gateway provider", async () => {
    // Direct vendors are NOT synthesized — their id formats are quirk-specific,
    // so an id missing from the static registry is a loud failure.
    credentials.set("anthropic", "anthropic-key");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "anthropic/claude-opus-9.9",
        agentType: "general",
        site,
      }),
    ).toThrow(/is not available from anthropic/i);
  });

  it("fails loudly for an unsupported provider prefix", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "totallyfakeprovider/some-model",
        agentType: "general",
        site,
      }),
    ).toThrow(/unknown model provider/i);
  });

  it("stays ready (canResolveLlmRoute) for an unhonorable pick when Stella is available", async () => {
    // A bad BYOK pick must not block the composer: the orchestrator is still
    // "ready" because a managed Stella route exists; the bad pick surfaces as a
    // toast at run time instead.
    const { canResolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(
      canResolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      }),
    ).toBe(true);
  });

  it("reports not-ready when neither a key nor a Stella account is available", async () => {
    const { canResolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(
      canResolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site: { baseUrl: null, getAuthToken: () => undefined },
      }),
    ).toBe(false);
  });

  it("uses OAuth credentials when no API key is set for the requested provider", async () => {
    oauthCredentials.add("anthropic");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
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
      stellaAppDir: "/tmp/stella",
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
      stellaAppDir: "/tmp/stella",
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
