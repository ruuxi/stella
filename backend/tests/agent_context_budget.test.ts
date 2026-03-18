import { describe, test, expect } from "bun:test";
import {
  resolveContextWindowTokens,
  isAutoCompactionEnabled,
  getAutoCompactionThresholdPct,
  computeAutoCompactionThresholdTokens,
  computeCompactionTriggerTokens,
  THREAD_COMPACTION_RESERVE_TOKENS,
} from "../convex/agent/context_budget";

describe("resolveContextWindowTokens", () => {
  test("returns default for non-string input", () => {
    const def = resolveContextWindowTokens(null);
    expect(def).toBeGreaterThan(0);
    expect(resolveContextWindowTokens(undefined)).toBe(def);
    expect(resolveContextWindowTokens(42)).toBe(def);
  });

  test("returns default for empty string", () => {
    const def = resolveContextWindowTokens(null);
    expect(resolveContextWindowTokens("")).toBe(def);
    expect(resolveContextWindowTokens("   ")).toBe(def);
  });

  test("returns known model context windows", () => {
    expect(resolveContextWindowTokens("anthropic/claude-opus-4.6")).toBe(200_000);
    expect(resolveContextWindowTokens("anthropic/claude-sonnet-4")).toBe(200_000);
  });

  test("returns default for unknown models", () => {
    const def = resolveContextWindowTokens(null);
    expect(resolveContextWindowTokens("unknown/model-xyz")).toBe(def);
  });
});

describe("isAutoCompactionEnabled", () => {
  test("returns a boolean", () => {
    expect(typeof isAutoCompactionEnabled()).toBe("boolean");
  });
});

describe("getAutoCompactionThresholdPct", () => {
  test("returns a value between 0 and 1", () => {
    const pct = getAutoCompactionThresholdPct();
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(1);
  });
});

describe("computeAutoCompactionThresholdTokens", () => {
  test("returns positive value", () => {
    const tokens = computeAutoCompactionThresholdTokens("anthropic/claude-opus-4.6");
    expect(tokens).toBeGreaterThan(0);
  });

  test("has minimum of 8000", () => {
    // Even with a very small context window, minimum is 8000
    const tokens = computeAutoCompactionThresholdTokens(null);
    expect(tokens).toBeGreaterThanOrEqual(8_000);
  });

  test("scales with model context window", () => {
    const large = computeAutoCompactionThresholdTokens("openai/gpt-5.3-codex"); // 400k
    const standard = computeAutoCompactionThresholdTokens("anthropic/claude-opus-4.6"); // 200k
    expect(large).toBeGreaterThan(standard);
  });
});

describe("computeCompactionTriggerTokens", () => {
  test("returns positive value", () => {
    const tokens = computeCompactionTriggerTokens("anthropic/claude-opus-4.6");
    expect(tokens).toBeGreaterThan(0);
  });

  test("equals context window minus reserve", () => {
    const contextWindow = resolveContextWindowTokens("anthropic/claude-opus-4.6");
    const trigger = computeCompactionTriggerTokens("anthropic/claude-opus-4.6");
    expect(trigger).toBe(contextWindow - THREAD_COMPACTION_RESERVE_TOKENS);
  });

  test("has minimum of 8000", () => {
    const tokens = computeCompactionTriggerTokens(null);
    expect(tokens).toBeGreaterThanOrEqual(8_000);
  });
});
