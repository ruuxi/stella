import { describe, test, expect } from "bun:test";
import {
  getModelConfig,
  DEFAULT_MODEL,
  AGENT_MODELS,
  AUDIENCE_AGENT_MODELS,
  hasModelConfig,
  resolveManagedModelAudience,
} from "../convex/agent/model";
import type { ModelConfig } from "../convex/agent/model";
import {
  listStellaCatalogModels,
  listStellaDefaultSelections,
  resolveStellaModelSelection,
  STELLA_BEST_MODEL,
  STELLA_FAST_MODEL,
  STELLA_MEDIA_MODEL,
} from "../convex/stella_models";

describe("DEFAULT_MODEL", () => {
  test("has a model string", () => {
    expect(typeof DEFAULT_MODEL.model).toBe("string");
    expect(DEFAULT_MODEL.model.length).toBeGreaterThan(0);
  });

  test("has a fallback model", () => {
    expect(typeof DEFAULT_MODEL.fallback).toBe("string");
  });

  test("has temperature and maxOutputTokens", () => {
    expect(typeof DEFAULT_MODEL.temperature).toBe("number");
    expect(typeof DEFAULT_MODEL.maxOutputTokens).toBe("number");
    expect(DEFAULT_MODEL.maxOutputTokens!).toBeGreaterThan(0);
  });
});

describe("AGENT_MODELS", () => {
  test("is a non-empty record", () => {
    expect(typeof AGENT_MODELS).toBe("object");
    expect(Object.keys(AGENT_MODELS).length).toBeGreaterThan(0);
  });

  test("includes orchestrator config", () => {
    expect(AGENT_MODELS.orchestrator).toBeDefined();
    expect(AGENT_MODELS.orchestrator.model).toBe("anthropic/claude-opus-4.6");
  });

  test("includes general config", () => {
    expect(AGENT_MODELS.general).toBeDefined();
    expect(typeof AGENT_MODELS.general.model).toBe("string");
  });

  test("includes self_mod config", () => {
    expect(AGENT_MODELS.self_mod).toBeDefined();
    expect(typeof AGENT_MODELS.self_mod.model).toBe("string");
  });

  test("includes dashboard_generation config", () => {
    expect(AGENT_MODELS.dashboard_generation).toBeDefined();
    expect(typeof AGENT_MODELS.dashboard_generation.model).toBe("string");
  });

  test("includes mercury config", () => {
    expect(AGENT_MODELS.mercury).toBeDefined();
    expect(AGENT_MODELS.mercury.model).toBe("inception/mercury-2");
  });

  test("includes llm and media llm configs", () => {
    expect(AGENT_MODELS.llm_best).toBeDefined();
    expect(AGENT_MODELS.llm_fast).toBeDefined();
    expect(AGENT_MODELS.media_llm).toBeDefined();
    expect(AGENT_MODELS.llm_fast.model).toBe("inception/mercury-2");
    expect(AGENT_MODELS.media_llm.model).toBe("google/gemini-3-flash");
  });

  test("each config has required model field", () => {
    for (const [, config] of Object.entries(AGENT_MODELS)) {
      expect(typeof config.model).toBe("string");
      expect(config.model.length).toBeGreaterThan(0);
    }
  });

  test("each gateway order entry is an individual provider slug", () => {
    const configs = [DEFAULT_MODEL, ...Object.values(AGENT_MODELS)];

    for (const config of configs) {
      const order = config.providerOptions?.gateway?.order;
      if (!Array.isArray(order)) continue;

      expect(order).toEqual(
        order.flatMap((entry): string[] =>
          typeof entry === "string"
            ? entry.split(",").map((provider) => provider.trim()).filter(Boolean)
            : [],
        ),
      );
    }
  });

  test("defines per-audience model catalogs for anonymous, free, and paid tiers", () => {
    expect(Object.keys(AUDIENCE_AGENT_MODELS)).toEqual([
      "anonymous",
      "free",
      "go",
      "pro",
      "plus",
      "ultra",
      "go_fallback",
      "pro_fallback",
      "plus_fallback",
      "ultra_fallback",
    ]);
    expect(AUDIENCE_AGENT_MODELS.anonymous.general.model).toBe(AGENT_MODELS.general.model);
    expect(AUDIENCE_AGENT_MODELS.plus.browser.model).toBe(AGENT_MODELS.browser.model);
    expect(AUDIENCE_AGENT_MODELS.pro_fallback.synthesis.model).toBe(AGENT_MODELS.synthesis.model);
  });
});

describe("getModelConfig", () => {
  test("returns orchestrator config for orchestrator", () => {
    const config = getModelConfig("orchestrator");
    expect(config).toBe(AGENT_MODELS.orchestrator);
  });

  test("returns general config for general", () => {
    const config = getModelConfig("general");
    expect(config).toBe(AGENT_MODELS.general);
  });

  test("returns self_mod config for self_mod", () => {
    const config = getModelConfig("self_mod");
    expect(config).toBe(AGENT_MODELS.self_mod);
  });

  test("returns dashboard_generation config for dashboard_generation", () => {
    const config = getModelConfig("dashboard_generation");
    expect(config).toBe(AGENT_MODELS.dashboard_generation);
  });

  test("returns mercury config for mercury", () => {
    const config = getModelConfig("mercury");
    expect(config).toBe(AGENT_MODELS.mercury);
  });

  test("resolves configs from the requested audience catalog", () => {
    const config = getModelConfig("general", "plus_fallback");
    expect(config.model).toBe(AUDIENCE_AGENT_MODELS.plus_fallback.general.model);
  });

  test("throws for unknown agent type", () => {
    expect(() => getModelConfig("unknown_agent_type")).toThrow(
      "No model config for agent type: unknown_agent_type",
    );
  });

  test("returned config satisfies ModelConfig type", () => {
    const config: ModelConfig = getModelConfig("general");
    expect(typeof config.model).toBe("string");
  });
});

describe("resolveManagedModelAudience", () => {
  test("maps free identities to anonymous or free audiences", () => {
    expect(resolveManagedModelAudience({ plan: "free", isAnonymous: true })).toBe("anonymous");
    expect(resolveManagedModelAudience({ plan: "free" })).toBe("free");
  });

  test("maps paid plans to primary and fallback audiences", () => {
    expect(resolveManagedModelAudience({ plan: "go" })).toBe("go");
    expect(resolveManagedModelAudience({ plan: "pro", downgraded: true })).toBe("pro_fallback");
    expect(resolveManagedModelAudience({ plan: "plus", downgraded: true })).toBe("plus_fallback");
  });
});

describe("hasModelConfig", () => {
  test("returns true for configured agent types", () => {
    expect(hasModelConfig("orchestrator")).toBe(true);
    expect(hasModelConfig("general")).toBe(true);
    expect(hasModelConfig("self_mod")).toBe(true);
    expect(hasModelConfig("dashboard_generation")).toBe(true);
  });

  test("returns false for unknown agent types", () => {
    expect(hasModelConfig("memory")).toBe(false);
  });
});

describe("listStellaDefaultSelections", () => {
  test("returns the Stella default alias for each configured agent", () => {
    const defaults = listStellaDefaultSelections();
    expect(defaults.length).toBe(Object.keys(AGENT_MODELS).length);
    expect(defaults).toContainEqual({
      agentType: "orchestrator",
      model: "stella/default",
      resolvedModel: AGENT_MODELS.orchestrator.model,
    });
    expect(defaults).toContainEqual({
      agentType: "explore",
      model: "stella/default",
      resolvedModel: "zai/glm-4.7",
    });
  });

  test("returns audience-specific resolved defaults", () => {
    const defaults = listStellaDefaultSelections("go_fallback");
    expect(defaults).toContainEqual({
      agentType: "orchestrator",
      model: "stella/default",
      resolvedModel: AUDIENCE_AGENT_MODELS.go_fallback.orchestrator.model,
    });
  });
});

describe("Stella SDK aliases", () => {
  test("resolves stable best/fast/media aliases", () => {
    expect(resolveStellaModelSelection("general", STELLA_BEST_MODEL)).toBe(
      AGENT_MODELS.llm_best.model,
    );
    expect(resolveStellaModelSelection("general", STELLA_FAST_MODEL)).toBe(
      AGENT_MODELS.llm_fast.model,
    );
    expect(resolveStellaModelSelection("general", STELLA_MEDIA_MODEL)).toBe(
      AGENT_MODELS.media_llm.model,
    );
  });

  test("publishes stable aliases in the Stella catalog", () => {
    const catalog = listStellaCatalogModels();
    expect(catalog).toContainEqual(
      expect.objectContaining({
        id: STELLA_BEST_MODEL,
        upstreamModel: AGENT_MODELS.llm_best.model,
      }),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({
        id: STELLA_FAST_MODEL,
        upstreamModel: AGENT_MODELS.llm_fast.model,
      }),
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({
        id: STELLA_MEDIA_MODEL,
        upstreamModel: AGENT_MODELS.media_llm.model,
        type: "multimodal",
      }),
    );
  });
});
