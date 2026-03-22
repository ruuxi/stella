import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../packages/ai/types.js";

const {
  getModelsMock,
  getLocalLlmCredentialMock,
} = vi.hoisted(() => ({
  getModelsMock: vi.fn(),
  getLocalLlmCredentialMock: vi.fn(),
}));

vi.mock("../../../packages/ai/models.js", () => ({
  getModels: getModelsMock,
}));

vi.mock("../../../packages/runtime-kernel/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: getLocalLlmCredentialMock,
}));

const { canResolveLlmRoute, resolveLlmRoute } = await import(
  "../../../packages/runtime-kernel/model-routing.js"
);

const createModel = (
  overrides: Partial<Model<any>> & Pick<Model<any>, "id" | "provider" | "api" | "baseUrl">,
): Model<any> => ({
  id: overrides.id,
  name: overrides.name ?? overrides.id,
  api: overrides.api,
  provider: overrides.provider,
  baseUrl: overrides.baseUrl,
  reasoning: overrides.reasoning ?? true,
  input: overrides.input ?? ["text"],
  cost: overrides.cost ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: overrides.contextWindow ?? 200_000,
  maxTokens: overrides.maxTokens ?? 16_384,
  compat: overrides.compat,
  headers: overrides.headers,
});

describe("stella model routing resolution", () => {
  beforeEach(() => {
    getModelsMock.mockReset();
    getLocalLlmCredentialMock.mockReset();
    getModelsMock.mockImplementation((provider: string) => {
      if (provider === "openai") {
        return [
          createModel({
            id: "gpt-5.4",
            name: "GPT-5.4",
            provider: "openai",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          }),
        ];
      }
      if (provider === "openrouter") {
        return [
          createModel({
            id: "openai/gpt-5.1-codex",
            name: "OpenAI GPT-5.1 Codex",
            provider: "openrouter",
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
          }),
        ];
      }
      return [];
    });
  });

  it("does not fabricate a direct-provider route for unknown model ids", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openai" ? "sk-openai-test" : null,
    );

    expect(() =>
      resolveLlmRoute({
        stellaHomePath: "C:/stella-home",
        modelName: "openai/custom-enterprise-model",
        agentType: "general",
        proxy: {
          baseUrl: null,
          getAuthToken: () => null,
        },
      }),
    ).toThrow("No usable model route is configured");
  });

  it("reports when no route can be resolved", () => {
    expect(
      canResolveLlmRoute({
        stellaHomePath: "C:/stella-home",
        modelName: "openai/custom-enterprise-model",
        proxy: {
          baseUrl: null,
          getAuthToken: () => null,
        },
      }),
    ).toBe(false);
  });

  it("does not fuzzy-match an imprecise direct-provider model id", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openai" ? "sk-openai-test" : null,
    );

    expect(() =>
      resolveLlmRoute({
        stellaHomePath: "C:/stella-home",
        modelName: "openai/gpt-5",
        agentType: "general",
        proxy: {
          baseUrl: null,
          getAuthToken: () => null,
        },
      }),
    ).toThrow("No usable model route is configured");
  });

  it("keeps exact openrouter routes reachable when explicitly requested", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openrouter"
          ? "sk-openrouter-test"
          : providerId === "openai"
            ? "sk-openai-test"
            : null,
    );

    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "openrouter/openai/gpt-5.1-codex",
      agentType: "general",
      proxy: {
        baseUrl: null,
        getAuthToken: () => null,
      },
    });

    expect(route.route).toBe("direct-openrouter");
    expect(route.model.provider).toBe("openrouter");
    expect(route.model.id).toBe("openai/gpt-5.1-codex");
    expect(route.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(route.getApiKey()).toBe("sk-openrouter-test");
  });

  it("falls back to openrouter when the direct provider key is missing", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openrouter" ? "sk-openrouter-test" : null,
    );

    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "openai/gpt-5.1-codex",
      agentType: "general",
      proxy: {
        baseUrl: "https://demo.convex.site/api/stella/v1",
        getAuthToken: () => "token-123",
      },
    });

    expect(route.route).toBe("direct-openrouter");
    expect(route.model.provider).toBe("openrouter");
    expect(route.model.id).toBe("openai/gpt-5.1-codex");
    expect(route.getApiKey()).toBe("sk-openrouter-test");
  });

  it("fails fast for stella models when stella is unavailable", () => {
    expect(() =>
      resolveLlmRoute({
        stellaHomePath: "C:/stella-home",
        modelName: "stella/openai/gpt-5.1-codex",
        agentType: "general",
        proxy: {
          baseUrl: null,
          getAuthToken: () => null,
        },
      }),
    ).toThrow("No usable model route is configured");
  });
});
