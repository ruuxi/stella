import { describe, expect, it } from "bun:test";

import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeRuntimeCatalogModels,
  normalizeStellaCatalogModels,
  searchCatalogModels,
} from "../../../src/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "../../../src/global/settings/lib/model-defaults";

describe("settings model catalog", () => {
  it("keeps the built-in local endpoint separate from worker-owned providers", () => {
    const models = listLocalCatalogModels();

    expect(models.map((model) => model.provider)).toEqual(["local"]);
    expect(models.every((model) => model.source === "local")).toBe(true);
    expect(models[0]?.id).toBe("local/llama3.2");
  });

  it("normalizes Stella backend rows and keeps Stella-specific models first when merging", () => {
    const stellaModels = normalizeStellaCatalogModels([
      {
        id: "stella/standard",
        name: "Stella Standard",
        provider: "stella",
        upstreamModel: "openai/gpt-5.5",
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
      "stella/standard",
      "openai/gpt-5.4",
      "openrouter/anthropic/claude-opus-4.7",
      "openrouter/openai/gpt-5.5",
    ]);
  });

  it("retains multimodal Stella modes (e.g. Stella Vision) in the catalog", () => {
    const models = normalizeStellaCatalogModels([
      {
        id: "stella/vision",
        name: "Stella Vision",
        provider: "stella",
        upstreamModel: "google/gemini-3-flash-preview",
        type: "multimodal",
      },
      {
        id: "stella/designer",
        name: "Stella Designer",
        provider: "stella",
        upstreamModel: "anthropic/claude-opus-4.8",
        type: "language",
      },
    ]);

    // Vision is multimodal — it must NOT be filtered out, or the mode is
    // unpickable in the desktop catalog.
    expect(models.map((model) => model.id)).toEqual([
      "stella/vision",
      "stella/designer",
    ]);
  });

  it("preserves per-agent Stella mode defaults from the backend", () => {
    const defaults = getLocalModelDefaults({ orchestrator: "stella/light" }, [
      {
        agentType: "orchestrator",
        model: "stella/standard",
        resolvedModel: "openai/gpt-5.5",
      },
      {
        agentType: "chronicle",
        model: "stella/light",
        resolvedModel: "deepseek/deepseek-v4-flash",
      },
    ]);
    const defaultMap = buildModelDefaultsMap(defaults);

    expect(defaultMap.orchestrator).toBe("stella/standard");
    expect(defaultMap.chronicle).toBe("stella/light");
    expect(
      normalizeModelOverrides({
        chronicle: "stella/light",
        schedule: "stella/standard",
      }),
    ).toEqual({
      chronicle: "stella/light",
      schedule: "stella/standard",
    });
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

  it("normalizes supported and runtime-managed providers only", () => {
    const base = {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      contextWindow: 500_000,
      maxTokens: 128_000,
    };
    const models = normalizeRuntimeCatalogModels(
      [
        { ...base, id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
        {
          ...base,
          id: "private-model",
          name: "Private model",
          provider: "my-extension",
        },
        {
          ...base,
          id: "bedrock-model",
          name: "Bedrock model",
          provider: "amazon-bedrock",
        },
        {
          ...base,
          api: "stella",
          id: "standard",
          name: "Stella Standard",
          provider: "stella",
        },
      ],
      [{ id: "my-extension", authManaged: true, credentialless: false }],
    );

    expect(models.map((model) => model.id)).toEqual([
      "my-extension/private-model",
      "xai/grok-4.5",
    ]);
  });
});
