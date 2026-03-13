import { describe, test, expect } from "bun:test";
import {
  GENERAL_AGENT_ENGINE_KEY,
  SELF_MOD_AGENT_ENGINE_KEY,
  MAX_AGENT_CONCURRENCY_KEY,
  PREFERRED_BROWSER_KEY,
  normalizeGeneralAgentEngine,
  normalizeMaxAgentConcurrency,
  normalizeSyncMode,
} from "../convex/data/preferences";

describe("preference key constants", () => {
  test("GENERAL_AGENT_ENGINE_KEY is a string", () => {
    expect(GENERAL_AGENT_ENGINE_KEY).toBe("general_agent_engine");
  });

  test("SELF_MOD_AGENT_ENGINE_KEY is a string", () => {
    expect(SELF_MOD_AGENT_ENGINE_KEY).toBe("self_mod_agent_engine");
  });

  test("MAX_AGENT_CONCURRENCY_KEY is a string", () => {
    expect(MAX_AGENT_CONCURRENCY_KEY).toBe("max_agent_concurrency");
  });

  test("PREFERRED_BROWSER_KEY is a string", () => {
    expect(typeof PREFERRED_BROWSER_KEY).toBe("string");
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

describe("normalizeMaxAgentConcurrency", () => {
  test("falls back for null", () => {
    expect(normalizeMaxAgentConcurrency(null)).toBe(24);
  });

  test("returns default for undefined", () => {
    expect(normalizeMaxAgentConcurrency(undefined)).toBe(24);
  });

  test("falls back for non-positive values", () => {
    expect(normalizeMaxAgentConcurrency("0")).toBe(24);
    expect(normalizeMaxAgentConcurrency("-3")).toBe(24);
  });

  test("parses valid number", () => {
    expect(normalizeMaxAgentConcurrency("12")).toBe(12);
  });

  test("caps oversized values at 24", () => {
    expect(normalizeMaxAgentConcurrency("999")).toBe(24);
  });

  test("returns default for non-numeric", () => {
    expect(normalizeMaxAgentConcurrency("abc")).toBe(24);
  });
});

describe("normalizeSyncMode", () => {
  test("returns on only when explicitly set to on", () => {
    expect(normalizeSyncMode("on")).toBe("on");
  });

  test("defaults missing values to off", () => {
    expect(normalizeSyncMode(undefined)).toBe("off");
    expect(normalizeSyncMode(null)).toBe("off");
  });

  test("defaults unknown values to off", () => {
    expect(normalizeSyncMode("unexpected")).toBe("off");
  });
});
