import { describe, test, expect } from "bun:test";
import {
  getModelConfig,
  DEFAULT_MODEL,
  AGENT_MODELS,
  hasModelConfig,
} from "../convex/agent/model";
import type { ModelConfig } from "../convex/agent/model";
import { listStellaDefaultSelections } from "../convex/stella_models";

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
    expect(AGENT_MODELS.orchestrator.model).toBe("moonshotai/kimi-k2.5");
  });

  test("includes general config", () => {
    expect(AGENT_MODELS.general).toBeDefined();
    expect(typeof AGENT_MODELS.general.model).toBe("string");
  });

  test("includes self_mod config", () => {
    expect(AGENT_MODELS.self_mod).toBeDefined();
    expect(typeof AGENT_MODELS.self_mod.model).toBe("string");
  });

  test("includes mercury config", () => {
    expect(AGENT_MODELS.mercury).toBeDefined();
    expect(AGENT_MODELS.mercury.model).toBe("inception/mercury-2");
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
        order.flatMap((entry) =>
          typeof entry === "string"
            ? entry.split(",").map((provider) => provider.trim()).filter(Boolean)
            : [entry],
        ),
      );
    }
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

  test("returns mercury config for mercury", () => {
    const config = getModelConfig("mercury");
    expect(config).toBe(AGENT_MODELS.mercury);
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

describe("hasModelConfig", () => {
  test("returns true for configured agent types", () => {
    expect(hasModelConfig("orchestrator")).toBe(true);
    expect(hasModelConfig("general")).toBe(true);
    expect(hasModelConfig("self_mod")).toBe(true);
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
      resolvedModel: "moonshotai/kimi-k2.5",
    });
    expect(defaults).toContainEqual({
      agentType: "explore",
      model: "stella/default",
      resolvedModel: "zai/glm-4.7",
    });
  });
});
