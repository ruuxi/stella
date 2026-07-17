import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../../runtime/ai/types.js";
import {
  getStellaVerbatimUpstreamModel,
  isOpenEndedGatewayProvider,
  isOpenEndedModelReference,
} from "../../../../runtime/kernel/model-routing-matching.js";

const credentials = new Map<string, string>();
const oauthCredentials = new Set<string>();

describe("open-ended model routing classification", () => {
  it("shares gateway and Stella pass-through acceptance with spawn parsing", () => {
    expect(isOpenEndedGatewayProvider("openrouter")).toBe(true);
    expect(isOpenEndedGatewayProvider("vercel-ai-gateway")).toBe(true);
    expect(isOpenEndedModelReference("openrouter/vendor/model:free")).toBe(
      true,
    );
    expect(
      isOpenEndedModelReference("stella/openrouter/vendor/model:high"),
    ).toBe(true);
    expect(isOpenEndedModelReference("stella/standard:high")).toBe(false);
    expect(
      getStellaVerbatimUpstreamModel(
        "stella/openrouter/arcee-ai/trinity-large-preview:free",
      ),
    ).toBe("openrouter/arcee-ai/trinity-large-preview:free");
  });
});

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
  capacity: { contextWindow: number; maxTokens: number } = {
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
): Model<any> => ({
  id,
  name: id,
  api: api as never,
  provider: provider as never,
  baseUrl: `https://${provider}.example.test`,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: capacity.contextWindow,
  maxTokens: capacity.maxTokens,
});

// The first OpenRouter registry entry the runtime clones as a synthesis
// template. Give it deliberately tiny capacity — mirroring the real
// `ai21/jamba-large-1.7` (maxTokens 4096) that caused the silent-finish bug —
// so the synthesis tests prove capacity is NEVER inherited from whatever
// model happens to sort first, regardless of how small its numbers are.
const OPENROUTER_TEMPLATE = model(
  "openrouter",
  "anthropic/claude-opus-4.6",
  "openai-completions",
  { contextWindow: 8_000, maxTokens: 4_096 },
);

vi.mock("../../../../runtime/ai/models.js", () => ({
  getModelProviders: () => [
    "openai",
    "openai-codex",
    "anthropic",
    "openrouter",
    "vercel-ai-gateway",
    "custom-extension",
    "generated-builtin",
    "moonshotai",
    "kimi-coding",
    "auth-required-proxy",
    "header-responses",
  ],
  getAllModels: () => [
    model("openai", "gpt-5.1-codex"),
    model("openai", "managed-with-engine-shadow"),
    model("openai", "managed-provider-collision"),
    model("openai-codex", "gpt-5.4", "openai-codex-responses"),
    model(
      "openai-codex",
      "managed-with-engine-shadow",
      "openai-codex-responses",
    ),
    model("anthropic", "claude-opus-4.6"),
    model("anthropic", "managed-provider-collision"),
    model("custom-extension", "extension-model"),
    model("generated-builtin", "generated-model"),
    model("moonshotai", "config-moonshot"),
    model("moonshotai", "extension-moonshot"),
    model("kimi-coding", "k2p5", "anthropic-messages"),
    model("auth-required-proxy", "proxy-model"),
    model("header-responses", "responses-model", "openai-responses"),
    OPENROUTER_TEMPLATE,
    model("vercel-ai-gateway", "openai/gpt-5.1-codex"),
  ],
  getModels: (provider: string) => {
    switch (provider) {
      case "openai":
        return [
          model("openai", "gpt-5.1-codex"),
          model("openai", "managed-with-engine-shadow"),
          model("openai", "managed-provider-collision"),
        ];
      case "openai-codex":
        return [
          model("openai-codex", "gpt-5.4", "openai-codex-responses"),
          model(
            "openai-codex",
            "managed-with-engine-shadow",
            "openai-codex-responses",
          ),
        ];
      case "anthropic":
        return [
          model("anthropic", "claude-opus-4.6"),
          model("anthropic", "managed-provider-collision"),
        ];
      case "openrouter":
        return [OPENROUTER_TEMPLATE];
      case "vercel-ai-gateway":
        return [model("vercel-ai-gateway", "openai/gpt-5.1-codex")];
      case "custom-extension":
        return [model("custom-extension", "extension-model")];
      case "generated-builtin":
        return [model("generated-builtin", "generated-model")];
      case "moonshotai":
        return [
          model("moonshotai", "config-moonshot"),
          model("moonshotai", "extension-moonshot"),
        ];
      case "kimi-coding":
        return [model("kimi-coding", "k2p5", "anthropic-messages")];
      case "auth-required-proxy":
        return [model("auth-required-proxy", "proxy-model")];
      case "header-responses":
        return [
          model("header-responses", "responses-model", "openai-responses"),
        ];
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

  it("does not let an unauthenticated extension bypass provider login", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(false);
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      expect(() =>
        resolveLlmRoute({
          stellaAppDir: "/tmp/stella",
          modelName: "custom-extension/extension-model",
          agentType: "general",
          site,
        }),
      ).toThrow(/no usable api key for custom extension/i);
    } finally {
      hasManagedAuth.mockRestore();
    }
  });

  it("does not infer credentialless routing from a generated registry entry", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "generated-builtin/generated-model",
        agentType: "general",
        site,
      }),
    ).toThrow(/no usable api key for generated builtin/i);
  });

  it("routes an origin-verified custom local proxy without credentials", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(false);
    const allowsCredentialless = vi
      .spyOn(modelRuntime, "allowsCredentiallessRouting")
      .mockReturnValue(true);
    const configuredHeaders = vi
      .spyOn(modelRuntime, "getConfiguredHeaders")
      .mockReturnValue({ "X-Command-Counter": "1" });
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "custom-extension/extension-model",
        agentType: "general",
        site,
      });
      expect(resolved.route).toBe("direct-provider");
      expect(configuredHeaders).not.toHaveBeenCalled();
      expect(await resolved.getApiKey()).toBe("");
      expect(configuredHeaders).toHaveBeenCalledTimes(1);
      expect(resolved.model.headers?.["X-Command-Counter"]).toBe("1");
      expect(await resolved.getApiKey()).toBe("");
      expect(configuredHeaders).toHaveBeenCalledTimes(1);
      expect(allowsCredentialless).toHaveBeenCalledWith("custom-extension");
    } finally {
      hasManagedAuth.mockRestore();
      allowsCredentialless.mockRestore();
      configuredHeaders.mockRestore();
    }
  });

  it("does not send an empty key for a configured authHeader requirement", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasOrigin = vi
      .spyOn(modelRuntime, "hasRuntimeProviderOrigin")
      .mockReturnValue(true);
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(false);
    const allowsCredentialless = vi
      .spyOn(modelRuntime, "allowsCredentiallessRouting")
      .mockReturnValue(false);
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      expect(() =>
        resolveLlmRoute({
          stellaAppDir: "/tmp/stella",
          modelName: "auth-required-proxy/proxy-model",
          agentType: "general",
          site,
        }),
      ).toThrow(/no usable api key for auth required proxy/i);
    } finally {
      hasOrigin.mockRestore();
      hasManagedAuth.mockRestore();
      allowsCredentialless.mockRestore();
    }
  });

  it("prefers a credentialless models.json Moonshot origin over the legacy alias", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasOrigin = vi
      .spyOn(modelRuntime, "hasRuntimeProviderOrigin")
      .mockReturnValue(true);
    const allowsCredentialless = vi
      .spyOn(modelRuntime, "allowsCredentiallessRouting")
      .mockReturnValue(true);
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "moonshotai/config-moonshot",
        agentType: "general",
        site,
      });

      expect(resolved.model).toMatchObject({
        provider: "moonshotai",
        id: "config-moonshot",
      });
      expect(await resolved.getApiKey()).toBe("");
    } finally {
      hasOrigin.mockRestore();
      allowsCredentialless.mockRestore();
    }
  });

  it("prefers an authenticated Moonshot extension origin over the legacy alias", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasOrigin = vi
      .spyOn(modelRuntime, "hasRuntimeProviderOrigin")
      .mockReturnValue(true);
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(true);
    const getManagedKey = vi
      .spyOn(modelRuntime, "getRuntimeManagedApiKey")
      .mockReturnValue("extension-moonshot-token");
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "moonshotai/extension-moonshot",
        agentType: "general",
        site,
      });

      expect(resolved.model).toMatchObject({
        provider: "moonshotai",
        id: "extension-moonshot",
      });
      await expect(resolved.getApiKey()).resolves.toBe(
        "extension-moonshot-token",
      );
    } finally {
      hasOrigin.mockRestore();
      hasManagedAuth.mockRestore();
      getManagedKey.mockRestore();
    }
  });

  it("keeps the legacy Moonshot-to-Kimi alias when no direct origin exists", async () => {
    credentials.set("kimi-coding", "legacy-kimi-token");
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasOrigin = vi
      .spyOn(modelRuntime, "hasRuntimeProviderOrigin")
      .mockReturnValue(false);
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "moonshotai/kimi-k2.5",
        agentType: "general",
        site,
      });

      expect(resolved.model).toMatchObject({
        provider: "kimi-coding",
        id: "k2p5",
      });
      await expect(resolved.getApiKey()).resolves.toBe("legacy-kimi-token");
    } finally {
      hasOrigin.mockRestore();
    }
  });

  it("does not resolve configured command auth until the request asks for it", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasConfigured = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(true);
    const resolveConfigured = vi
      .spyOn(modelRuntime, "getRuntimeManagedApiKey")
      .mockReturnValue("configured-token");
    const usesAuthHeader = vi
      .spyOn(modelRuntime, "usesConfiguredAuthHeader")
      .mockReturnValue(true);
    const configuredHeaders = vi
      .spyOn(modelRuntime, "getConfiguredHeaders")
      .mockReturnValue({ authorization: "stale-value" });
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      });

      expect(hasConfigured).toHaveBeenCalledWith("openai");
      expect(resolveConfigured).not.toHaveBeenCalled();
      expect(configuredHeaders).not.toHaveBeenCalled();
      await expect(resolved.getApiKey()).resolves.toBe("configured-token");
      expect(resolveConfigured).toHaveBeenCalledTimes(1);
      expect(configuredHeaders).toHaveBeenCalledTimes(1);
      expect(resolved.model.headers?.Authorization).toBe(
        "Bearer configured-token",
      );
      expect(
        Object.keys(resolved.model.headers ?? {}).filter(
          (name) => name.toLowerCase() === "authorization",
        ),
      ).toEqual(["Authorization"]);
      await expect(resolved.getApiKey()).resolves.toBe("configured-token");
      expect(configuredHeaders).toHaveBeenCalledTimes(1);
    } finally {
      hasConfigured.mockRestore();
      resolveConfigured.mockRestore();
      usesAuthHeader.mockRestore();
      configuredHeaders.mockRestore();
    }
  });

  it("supports a header-only Responses provider without an API key", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(true);
    const resolveManagedAuth = vi
      .spyOn(modelRuntime, "getRuntimeManagedApiKey")
      .mockReturnValue(undefined);
    const configuredHeaders = vi
      .spyOn(modelRuntime, "getConfiguredHeaders")
      .mockReturnValue({ Authorization: "Bearer header-token" });
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "header-responses/responses-model",
        agentType: "general",
        site,
      });

      expect(resolved.model.api).toBe("openai-responses");
      expect(configuredHeaders).not.toHaveBeenCalled();
      await expect(resolved.getApiKey()).resolves.toBeUndefined();
      expect(configuredHeaders).toHaveBeenCalledTimes(1);
      expect(resolved.model.headers?.Authorization).toBe(
        "Bearer header-token",
      );
    } finally {
      hasManagedAuth.mockRestore();
      resolveManagedAuth.mockRestore();
      configuredHeaders.mockRestore();
    }
  });

  it("defers an unresolved configured key and never routes it as empty", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasConfigured = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(true);
    const resolveConfigured = vi
      .spyOn(modelRuntime, "getRuntimeManagedApiKey")
      .mockImplementation(() => {
        throw new Error(
          'Required models.json API key for provider "openai" could not be resolved.',
        );
      });
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      });

      expect(resolveConfigured).not.toHaveBeenCalled();
      await expect(resolved.getApiKey()).rejects.toThrow(
        /Required models\.json API key for provider "openai" could not be resolved/u,
      );
      expect(resolveConfigured).toHaveBeenCalledTimes(1);
    } finally {
      hasConfigured.mockRestore();
      resolveConfigured.mockRestore();
    }
  });

  it("routes a known provider whose extension owns authentication", async () => {
    const { modelRuntime } = await import(
      "../../../../runtime/ai/model-runtime.js"
    );
    const hasManagedAuth = vi
      .spyOn(modelRuntime, "hasRuntimeManagedAuth")
      .mockReturnValue(true);
    const resolveManagedAuth = vi
      .spyOn(modelRuntime, "getRuntimeManagedApiKey")
      .mockReturnValue(undefined);
    try {
      const { resolveLlmRoute } = await import(
        "../../../../runtime/kernel/model-routing.js"
      );
      const resolved = resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "openai/gpt-5.1-codex",
        agentType: "general",
        site,
      });

      expect(resolved.route).toBe("direct-provider");
      await expect(resolved.getApiKey()).resolves.toBeUndefined();
      expect(resolveManagedAuth).toHaveBeenCalledTimes(1);
    } finally {
      hasManagedAuth.mockRestore();
      resolveManagedAuth.mockRestore();
    }
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
    expect(resolved.model.api).toBe("openai-completions");
    expect(resolved.model.provider).toBe("openrouter");
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

  it("ignores engine-native registry shadows when one managed provider matches", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/managed-with-engine-shadow",
      agentType: "general",
      site,
    });

    expect(resolved.model.provider).toBe("openai");
    expect(
      (resolved.model as typeof resolved.model & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("managed-with-engine-shadow");
  });

  it("fails deterministically for a genuine managed-provider collision", async () => {
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    expect(() =>
      resolveLlmRoute({
        stellaAppDir: "/tmp/stella",
        modelName: "stella/managed-provider-collision",
        agentType: "general",
        site,
      }),
    ).toThrow(/not available from stella/i);
  });

  it("lets catalog metadata resolve a genuine managed-provider collision", async () => {
    const { resolveLlmRouteForCatalogEnrichment } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );
    const {
      invalidateStellaModelCatalogCache,
      withStellaModelCatalogMetadata,
    } = await import("../../../../runtime/kernel/stella-model-catalog.js");
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "stella/managed-provider-collision",
                name: "Managed collision",
                provider: "stella",
                upstreamModel: "anthropic/managed-provider-collision",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const route = resolveLlmRouteForCatalogEnrichment({
        stellaAppDir: "/tmp/stella",
        modelName: "stella/managed-provider-collision",
        agentType: "general",
        site,
      });
      const enriched = await withStellaModelCatalogMetadata({
        route,
        agentType: "general",
        site,
        deviceId: "device-managed-collision",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(enriched.model.provider).toBe("anthropic");
      expect(
        (
          enriched.model as typeof enriched.model & {
            upstreamModelId?: string;
          }
        ).upstreamModelId,
      ).toBe("managed-provider-collision");
    } finally {
      globalThis.fetch = originalFetch;
      invalidateStellaModelCatalogCache();
    }
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

  it("routes the orchestrator through the existing ChatGPT OAuth credential", async () => {
    oauthCredentials.add("openai-codex");
    const { resolveLlmRoute } = await import(
      "../../../../runtime/kernel/model-routing.js"
    );

    const resolved = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "openai-codex/gpt-5.4",
      agentType: "orchestrator",
      site,
    });

    expect(resolved.route).toBe("direct-provider");
    expect(resolved.model.provider).toBe("openai-codex");
    expect(resolved.model.api).toBe("openai-codex-responses");
    await expect(resolved.getApiKey()).resolves.toBe(
      "openai-codex-oauth-token",
    );
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
    // The dynamic provider catalog may show an OpenRouter id the runtime
    // registry hasn't picked up yet. Rather than failing, we clone the
    // OpenRouter template and let OpenRouter validate the id upstream.
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

  it("uses self-contained capacity defaults, never the template's limits, when synthesizing", async () => {
    // The cloned template (OPENROUTER_TEMPLATE) deliberately carries tiny
    // capacity (maxTokens 4096, contextWindow 8000), mirroring the real
    // ai21/jamba-large-1.7 that triggered the silent-finish bug. Synthesis
    // must NOT inherit those numbers: buildBaseOptions turns model.maxTokens
    // into a hard max_tokens cap per request, which a reasoning model can
    // exhaust entirely on thinking (run truncates with no visible reply), and
    // a small contextWindow makes compaction/overflow prune history early.
    // The synthesized model must send no cap (maxTokens: 0) and carry a
    // generous 200k context floor regardless of the template.
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

    // Exact constants, not the template's 4096 / 8000.
    expect(resolved.model.maxTokens).toBe(0);
    expect(resolved.model.contextWindow).toBe(200_000);
    expect(resolved.model.maxTokens).not.toBe(OPENROUTER_TEMPLATE.maxTokens);
    expect(resolved.model.contextWindow).not.toBe(
      OPENROUTER_TEMPLATE.contextWindow,
    );
  });

  it("declares image input on synthesized gateway models, never the template's modalities", async () => {
    // The template (like the real ai21/jamba-large-1.7) is text-only. If the
    // synthesized clone inherited that, transformMessages would silently swap
    // every user image for an "(image omitted: model does not support images)"
    // placeholder — which is exactly how mobile photo attachments to a
    // vision-capable OpenRouter model got dropped before the dynamic catalog
    // finished loading. The gateway is the authority on modality: a
    // truly text-only model rejects image blocks loudly upstream.
    expect(OPENROUTER_TEMPLATE.input).toEqual(["text"]);
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

    expect(resolved.model.input).toEqual(["text", "image"]);
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
