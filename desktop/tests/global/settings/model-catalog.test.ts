import { describe, expect, it } from "bun:test";

import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeDirectProviderCatalogModels,
  normalizeManagedGatewayCatalogModels,
  normalizeStellaCatalogModels,
  searchCatalogModels,
} from "../../../src/global/settings/lib/model-catalog";

describe("settings model catalog", () => {
  it("lists runtime local-provider models separately from Stella models", () => {
    const models = listLocalCatalogModels();

    expect(models.some((model) => model.provider === "anthropic")).toBe(true);
    expect(models.some((model) => model.provider === "openai")).toBe(true);
    expect(models.some((model) => model.provider === "amazon-bedrock")).toBe(
      false,
    );
    expect(
      models.some((model) => model.provider === "azure-openai-responses"),
    ).toBe(false);
    expect(models.every((model) => model.source === "local")).toBe(true);
    expect(models.every((model) => model.id.startsWith("stella/"))).toBe(false);
  });

  it("normalizes Stella backend rows and keeps Stella-specific models first when merging", () => {
    const stellaModels = normalizeStellaCatalogModels([
      {
        id: "stella/default",
        name: "Stella Recommended",
        provider: "stella",
        upstreamModel: "",
      },
      {
        id: "openrouter/anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7 via Stella",
        provider: "openrouter",
        upstreamModel: "anthropic/claude-opus-4.7",
      },
    ]);
    const localModels = [
      {
        id: "openai/gpt-5.4",
        modelId: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        providerName: "OpenAI",
        source: "local" as const,
      },
      {
        id: "openrouter/openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        name: "GPT-5.5",
        provider: "openrouter",
        providerName: "OpenRouter",
        source: "local" as const,
      },
    ];

    const merged = mergeCatalogModels(stellaModels, localModels);

    expect(merged.map((model) => model.id)).toEqual([
      "stella/default",
      "openai/gpt-5.4",
      "openrouter/anthropic/claude-opus-4.7",
      "openrouter/openai/gpt-5.5",
    ]);
  });

  it("groups by provider and supports provider/model search", () => {
    const models = [
      {
        id: "stella/openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        name: "GPT-5.5",
        provider: "stella",
        providerName: "Stella",
        source: "stella" as const,
      },
      {
        id: "stella/designer",
        modelId: "designer",
        name: "Stella Designer",
        provider: "stella",
        providerName: "Stella",
        source: "stella" as const,
      },
      {
        id: "anthropic/claude-opus-4.7",
        modelId: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        provider: "anthropic",
        providerName: "Anthropic",
        source: "local" as const,
      },
    ];

    expect(
      groupCatalogModelsByProvider(models).map((group) => group.provider),
    ).toEqual(["stella", "anthropic"]);
    expect(
      groupCatalogModelsByProvider(models)[0].models.map((model) => model.id),
    ).toEqual(["stella/designer", "stella/openai/gpt-5.5"]);
    expect(
      searchCatalogModels(models, "opus").map((model) => model.id),
    ).toEqual(["anthropic/claude-opus-4.7"]);
    expect(
      searchCatalogModels(models, "anthropic").map((model) => model.id),
    ).toEqual(["anthropic/claude-opus-4.7"]);
  });

  it("adds managed gateway models as Stella-routed catalog entries", () => {
    const models = normalizeManagedGatewayCatalogModels({
      openrouter: {
        models: {
          "meta-llama/llama-3.3-70b-instruct": {
            id: "meta-llama/llama-3.3-70b-instruct",
            name: "Llama 3.3 70B Instruct",
          },
        },
      },
      "fireworks-ai": {
        models: {
          "accounts/fireworks/models/kimi-k2p6": {
            id: "accounts/fireworks/models/kimi-k2p6",
            name: "Kimi K2P6",
          },
        },
      },
    });

    expect(models.map((model) => model.id)).toEqual([
      "stella/accounts/fireworks/models/kimi-k2p6",
      "stella/meta-llama/llama-3.3-70b-instruct",
    ]);
    expect(models.every((model) => model.provider === "stella")).toBe(true);
    expect(models.map((model) => model.upstreamModel)).toEqual([
      "accounts/fireworks/models/kimi-k2p6",
      "meta-llama/llama-3.3-70b-instruct",
    ]);
  });

  it("adds live models.dev direct-provider rows for supported text models", () => {
    const models = normalizeDirectProviderCatalogModels({
      openai: {
        models: {
          "gpt-5.5": {
            id: "gpt-5.5",
            name: "GPT-5.5",
            reasoning: true,
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"],
            },
            limit: {
              context: 1_050_000,
              output: 128_000,
            },
          },
          "gpt-image-1.5": {
            id: "gpt-image-1.5",
            name: "gpt-image-1.5",
            modalities: {
              input: ["text"],
              output: ["image"],
            },
          },
        },
      },
      "fireworks-ai": {
        models: {
          "accounts/fireworks/models/kimi-k2p6": {
            id: "accounts/fireworks/models/kimi-k2p6",
            name: "Kimi K2P6",
          },
        },
      },
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "openai/gpt-5.5",
      modelId: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      source: "local",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });
});
