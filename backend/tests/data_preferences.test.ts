import { describe, test, expect } from "bun:test";
import {
  GENERAL_AGENT_ENGINE_KEY,
  CODEX_LOCAL_MAX_CONCURRENCY_KEY,
  DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY,
  MIN_CODEX_LOCAL_MAX_CONCURRENCY,
  MAX_CODEX_LOCAL_MAX_CONCURRENCY,
  PREFERRED_BROWSER_KEY,
  normalizeGeneralAgentEngine,
  normalizeCodexLocalMaxConcurrency,
} from "../convex/data/preferences";

describe("preference key constants", () => {
  test("GENERAL_AGENT_ENGINE_KEY is a string", () => {
    expect(GENERAL_AGENT_ENGINE_KEY).toBe("general_agent_engine");
  });

  test("CODEX_LOCAL_MAX_CONCURRENCY_KEY is a string", () => {
    expect(typeof CODEX_LOCAL_MAX_CONCURRENCY_KEY).toBe("string");
  });

  test("PREFERRED_BROWSER_KEY is a string", () => {
    expect(typeof PREFERRED_BROWSER_KEY).toBe("string");
  });

  test("concurrency bounds are consistent", () => {
    expect(MIN_CODEX_LOCAL_MAX_CONCURRENCY).toBeLessThanOrEqual(DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY);
    expect(DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY).toBeLessThanOrEqual(MAX_CODEX_LOCAL_MAX_CONCURRENCY);
  });
});

describe("normalizeGeneralAgentEngine", () => {
  test("returns default for default", () => {
    expect(normalizeGeneralAgentEngine("default")).toBe("default");
  });

  test("returns codex_local for codex_local", () => {
    expect(normalizeGeneralAgentEngine("codex_local")).toBe("codex_local");
  });

  test("returns claude_code_local for claude_code_local", () => {
    expect(normalizeGeneralAgentEngine("claude_code_local")).toBe("claude_code_local");
  });

  test("returns default for null", () => {
    expect(normalizeGeneralAgentEngine(null)).toBe("default");
  });

  test("returns default for unknown", () => {
    expect(normalizeGeneralAgentEngine("unknown")).toBe("default");
  });
});

describe("normalizeCodexLocalMaxConcurrency", () => {
  test("clamps null (Number(null)=0) to min", () => {
    expect(normalizeCodexLocalMaxConcurrency(null)).toBe(MIN_CODEX_LOCAL_MAX_CONCURRENCY);
  });

  test("returns default for undefined", () => {
    expect(normalizeCodexLocalMaxConcurrency(undefined)).toBe(DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY);
  });

  test("clamps to min", () => {
    expect(normalizeCodexLocalMaxConcurrency("0")).toBe(MIN_CODEX_LOCAL_MAX_CONCURRENCY);
  });

  test("clamps to max", () => {
    expect(normalizeCodexLocalMaxConcurrency("999")).toBe(MAX_CODEX_LOCAL_MAX_CONCURRENCY);
  });

  test("parses valid number", () => {
    const result = normalizeCodexLocalMaxConcurrency("2");
    expect(result).toBeGreaterThanOrEqual(MIN_CODEX_LOCAL_MAX_CONCURRENCY);
    expect(result).toBeLessThanOrEqual(MAX_CODEX_LOCAL_MAX_CONCURRENCY);
  });

  test("returns default for non-numeric", () => {
    expect(normalizeCodexLocalMaxConcurrency("abc")).toBe(DEFAULT_CODEX_LOCAL_MAX_CONCURRENCY);
  });
});
