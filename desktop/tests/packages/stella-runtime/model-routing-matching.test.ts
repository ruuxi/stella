import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../electron/core/ai/types.js";

const { getModelsMock } = vi.hoisted(() => ({
  getModelsMock: vi.fn(),
}));

vi.mock("../../../electron/core/ai/models.js", () => ({
  getModels: getModelsMock,
}));

const {
  findRegistryModel,
  parseModelReference,
} = await import("../../../electron/core/runtime/model-routing-matching.js");

const createModel = (
  overrides: Partial<Model<any>> &
    Pick<Model<any>, "id" | "provider" | "api" | "baseUrl">,
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
});

describe("model routing matching helpers", () => {
  beforeEach(() => {
    getModelsMock.mockReset();
  });

  it("prefers alias ids over dated ids for partial matches", () => {
    getModelsMock.mockImplementation((provider: string) => {
      if (provider !== "anthropic") {
        return [];
      }
      return [
        createModel({
          id: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        }),
        createModel({
          id: "claude-sonnet-4-5",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        }),
      ];
    });

    const match = findRegistryModel("anthropic", ["sonnet-4-5"]);

    expect(match?.id).toBe("claude-sonnet-4-5");
  });

  it("parses provider-qualified model references without losing nested model ids", () => {
    expect(parseModelReference("openrouter/openai/gpt-5.1-codex")).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-5.1-codex",
      fullModelId: "openrouter/openai/gpt-5.1-codex",
    });
  });
});
