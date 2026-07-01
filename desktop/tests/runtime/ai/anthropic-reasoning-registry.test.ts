import { describe, expect, it } from "vitest";
import { getModels } from "../../../../runtime/ai/models.js";
import type { Model } from "../../../../runtime/ai/types.js";
import type { ResolvedLlmRoute } from "../../../../runtime/kernel/model-routing.js";
import { resolveAgentThinkingLevel } from "../../../../runtime/kernel/agent-runtime/shared.js";

// Regression guard for the stale generated model registry that shipped without
// the current Anthropic models. When `claude-opus-4-8` is missing from the
// native `anthropic` block (or resolves without `reasoning: true`), a direct
// (BYOK) Anthropic run never requests extended thinking, so sub-agents produce
// no reasoning and the rolling reasoning summaries stay empty. These assertions
// pin the models + their thinking/reasoning capability so a future regen can't
// silently drop them again.

const anthropicModels = () =>
  getModels("anthropic") as Model<"anthropic-messages">[];

const findModel = (id: string): Model<"anthropic-messages"> | undefined =>
  anthropicModels().find((model) => model.id === id);

describe("native Anthropic model registry", () => {
  it("includes the current Opus models with extended-thinking capability", () => {
    for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
      const model = findModel(id);
      expect(model, `expected ${id} in the native anthropic registry`).toBeDefined();
      expect(model?.api).toBe("anthropic-messages");
      expect(model?.provider).toBe("anthropic");
      // reasoning: true is what drives thinkingLevel != "off", i.e. the runtime
      // actually requesting extended thinking from the provider.
      expect(model?.reasoning).toBe(true);
    }
  });

  it("maps xhigh effort for adaptive-thinking Opus 4.7/4.8", () => {
    expect(findModel("claude-opus-4-7")?.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(findModel("claude-opus-4-8")?.thinkingLevelMap?.xhigh).toBe("xhigh");
  });

  it("includes Claude Fable 5 with adaptive-thinking capability", () => {
    // Fable 5 rejects budget-based `thinking.type=enabled` — Anthropic returns
    // a 400 telling callers to use `thinking.type.adaptive` + effort. The
    // native API id is exactly `claude-fable-5` (verified against
    // GET /v1/models); adaptive effort `max` is accepted.
    const model = findModel("claude-fable-5");
    expect(model, "expected claude-fable-5 in the native anthropic registry").toBeDefined();
    expect(model?.api).toBe("anthropic-messages");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap?.xhigh).toBe("max");
  });
});

describe("claude-opus-4-8 permits reasoning for a direct sub-agent route", () => {
  const opus48Route = (): ResolvedLlmRoute => {
    const model = findModel("claude-opus-4-8");
    if (!model) throw new Error("claude-opus-4-8 missing from registry");
    return {
      route: "direct-provider",
      model,
      getApiKey: async () => "sk-ant-test",
      refreshApiKey: async () => null,
    } as unknown as ResolvedLlmRoute;
  };

  it("requests thinking by default (no explicit effort) instead of 'off'", () => {
    const level = resolveAgentThinkingLevel({ resolvedLlm: opus48Route() });
    expect(level).not.toBe("off");
    expect(level).toBe("medium");
  });

  it("honors an explicit reasoning effort", () => {
    expect(
      resolveAgentThinkingLevel({
        resolvedLlm: opus48Route(),
        agentContextReasoningEffort: "high",
      }),
    ).toBe("high");
  });
});
