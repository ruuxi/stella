import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../../../packages/ai/types.js";

const { getModelsMock } = vi.hoisted(() => ({
  getModelsMock: vi.fn(),
}));

vi.mock("../../../packages/ai/models.js", () => ({
  getModels: getModelsMock,
}));

const {
  findRegistryModel,
  parseModelReference,
} = await import("../../../packages/runtime-kernel/model-routing-matching.js");

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

  it("matches exact and normalized ids without fuzzy fallback", () => {
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

    expect(findRegistryModel("anthropic", ["claude-sonnet-4.5"])?.id).toBe(
      "claude-sonnet-4-5",
    );
    expect(findRegistryModel("anthropic", ["sonnet-4-5"])).toBeNull();
  });

  it("matches canonical provider-qualified ids exactly", () => {
    getModelsMock.mockImplementation((provider: string) => {
      if (provider !== "openrouter") {
        return [];
      }
      return [
        createModel({
          id: "openai/gpt-5.1-codex",
          provider: "openrouter",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
      ];
    });

    expect(
      findRegistryModel("openrouter", ["openrouter/openai/gpt-5.1-codex"])?.id,
    ).toBe("openai/gpt-5.1-codex");
  });

  it("parses provider-qualified model references without losing nested model ids", () => {
    expect(parseModelReference("openrouter/openai/gpt-5.1-codex")).toEqual({
      provider: "openrouter",
      modelId: "openai/gpt-5.1-codex",
      fullModelId: "openrouter/openai/gpt-5.1-codex",
    });
  });
});
