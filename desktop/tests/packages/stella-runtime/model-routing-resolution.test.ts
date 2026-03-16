import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../electron/core/ai/types.js";

const {
  getModelsMock,
  getLocalLlmCredentialMock,
} = vi.hoisted(() => ({
  getModelsMock: vi.fn(),
  getLocalLlmCredentialMock: vi.fn(),
}));

vi.mock("../../../electron/core/ai/models.js", () => ({
  getModels: getModelsMock,
}));

vi.mock("../../../electron/core/runtime/storage/llm-credentials.js", () => ({
  getLocalLlmCredential: getLocalLlmCredentialMock,
}));

const { resolveLlmRoute } = await import(
  "../../../electron/core/runtime/model-routing.js"
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

  it("falls back to a custom direct-provider model id when a local provider key exists", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openai" ? "sk-openai-test" : null,
    );

    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "openai/custom-enterprise-model",
      agentType: "general",
      proxy: {
        baseUrl: null,
        getAuthToken: () => null,
      },
    });

    expect(route.route).toBe("direct-provider");
    expect(route.model.provider).toBe("openai");
    expect(route.model.id).toBe("custom-enterprise-model");
    expect(route.model.baseUrl).toBe("https://api.openai.com/v1");
    expect(route.getApiKey()).toBe("sk-openai-test");
  });

  it("falls back to a custom openrouter model id when only an openrouter key exists", () => {
    getLocalLlmCredentialMock.mockImplementation(
      (_stellaHomePath: string, providerId: string) =>
        providerId === "openrouter" ? "sk-openrouter-test" : null,
    );

    const route = resolveLlmRoute({
      stellaHomePath: "C:/stella-home",
      modelName: "openai/private-preview",
      agentType: "general",
      proxy: {
        baseUrl: null,
        getAuthToken: () => null,
      },
    });

    expect(route.route).toBe("direct-openrouter");
    expect(route.model.provider).toBe("openrouter");
    expect(route.model.id).toBe("openai/private-preview");
    expect(route.model.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(route.getApiKey()).toBe("sk-openrouter-test");
  });
});
