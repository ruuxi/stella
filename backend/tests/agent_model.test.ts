import { describe, test, expect } from "bun:test";
import { getModelConfig, DEFAULT_MODEL, AGENT_MODELS } from "../convex/agent/model";
import type { ModelConfig } from "../convex/agent/model";

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
    expect(typeof AGENT_MODELS.orchestrator.model).toBe("string");
  });

  test("includes general config", () => {
    expect(AGENT_MODELS.general).toBeDefined();
    expect(typeof AGENT_MODELS.general.model).toBe("string");
  });

  test("each config has required model field", () => {
    for (const [, config] of Object.entries(AGENT_MODELS)) {
      expect(typeof config.model).toBe("string");
      expect(config.model.length).toBeGreaterThan(0);
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

  test("falls back to DEFAULT_MODEL for unknown agent type", () => {
    const config = getModelConfig("unknown_agent_type");
    expect(config).toBe(DEFAULT_MODEL);
  });

  test("returned config satisfies ModelConfig type", () => {
    const config: ModelConfig = getModelConfig("orchestrator");
    expect(typeof config.model).toBe("string");
  });
});
