import { describe, expect, it } from "vitest";
import {
  supportsAdaptiveThinking,
  supportsDisablingThinking,
} from "../../../../runtime/ai/providers/anthropic.js";

// Regression guard for the thinking-shape gate. 5-generation Claude models
// (and Opus/Sonnet 4.6+) reject the legacy budget-based
// `thinking.type=enabled` request shape with a 400 telling callers to use
// `thinking.type.adaptive` + `output_config.effort`. The gate used to be a
// hardcoded id list (opus-4-6/4-7/4-8, sonnet-4-6, fable-5), which broke
// direct-path spawns on `anthropic/claude-sonnet-5`; it is now a
// family-version predicate so future 5-family models get adaptive by default.

describe("supportsAdaptiveThinking", () => {
  it("selects adaptive for all 5-generation Claude models", () => {
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-fable-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-5")).toBe(true);
    // Date-suffixed and dotted-minor variants
    expect(supportsAdaptiveThinking("claude-sonnet-5-20260101")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5.1")).toBe(true);
  });

  it("selects adaptive for Opus/Sonnet 4.6+", () => {
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4.6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-7")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-4-8")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4.6")).toBe(true);
  });

  it("keeps the legacy budget-based shape for older models", () => {
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5-20250929")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5-thinking")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-20250514")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-0")).toBe(false);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-opus-4-1-20250805")).toBe(false);
    // Old-style ids put the version before the family; they never parse as
    // a new-style family-version id (and date suffixes must not parse as
    // version numbers).
    expect(supportsAdaptiveThinking("claude-3-5-sonnet-20241022")).toBe(false);
    expect(supportsAdaptiveThinking("claude-3-5-haiku-20241022")).toBe(false);
    expect(supportsAdaptiveThinking("claude-3-haiku-20240307")).toBe(false);
    expect(supportsAdaptiveThinking("claude-3-7-sonnet-20250219")).toBe(false);
  });

  it("handles Bedrock-style prefixed ids", () => {
    expect(supportsAdaptiveThinking("us.anthropic.claude-opus-4-8")).toBe(true);
    expect(supportsAdaptiveThinking("global.anthropic.claude-sonnet-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(false);
    expect(supportsAdaptiveThinking("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(false);
  });

  it("returns false for non-Claude ids", () => {
    expect(supportsAdaptiveThinking("gpt-5.2")).toBe(false);
    expect(supportsAdaptiveThinking("gemini-3-pro")).toBe(false);
  });
});

// Fable models reject `thinking.type=disabled` with a 400 ("Thinking defaults
// to adaptive"); the request must omit the `thinking` param instead. This is
// the shape that silently killed thread compaction when `stella/max` remapped
// to `claude-fable-5` upstream.
describe("supportsDisablingThinking", () => {
  it("rejects disabling for Fable-family models", () => {
    expect(supportsDisablingThinking("claude-fable-5")).toBe(false);
    expect(supportsDisablingThinking("claude-fable-5-20260601")).toBe(false);
    expect(supportsDisablingThinking("claude-fable-5.1")).toBe(false);
    expect(supportsDisablingThinking("us.anthropic.claude-fable-5")).toBe(false);
  });

  it("keeps the disabled shape for models that accept it", () => {
    expect(supportsDisablingThinking("claude-opus-4-8")).toBe(true);
    expect(supportsDisablingThinking("claude-sonnet-5")).toBe(true);
    expect(supportsDisablingThinking("claude-sonnet-4-5-20250929")).toBe(true);
    expect(supportsDisablingThinking("claude-haiku-4-5")).toBe(true);
    expect(supportsDisablingThinking("gpt-5.2")).toBe(true);
  });
});
