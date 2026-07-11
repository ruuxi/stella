import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../../../src/global/settings/lib/model-catalog";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  listChatGptCatalogModels,
} from "../../../src/global/settings/lib/engine-model-routing";

const catalogModel = (provider: string, modelId: string): CatalogModel => ({
  id: `${provider}/${modelId}`,
  name: modelId,
  provider,
  providerName: provider,
  modelId,
  source: "local",
});

const preferences = {
  modelOverrides: {
    orchestrator: "anthropic/claude-opus-4.8",
    general: "anthropic/claude-opus-4.8",
    chronicle: "stella/light",
  },
  assistantPropagatedAgents: ["general", "explore"],
  agentRuntimeEngine: "default" as const,
  codexModel: "gpt-5.4",
  claudeCodeModel: "sonnet",
};

describe("engine model routing", () => {
  it("scopes ChatGPT to OpenAI OAuth catalog models", () => {
    const models = [
      catalogModel("stella", "standard"),
      catalogModel("openai", "gpt-5.4"),
      catalogModel("openai-codex", "gpt-5.4"),
      catalogModel("anthropic", "claude-opus-4.8"),
    ];

    expect(listChatGptCatalogModels(models).map((model) => model.id)).toEqual([
      "openai-codex/gpt-5.4",
    ]);
  });

  it("routes ChatGPT orchestrator through OAuth and general through Codex", () => {
    expect(
      buildEngineRoutingPatch(preferences, "codex_cli", "gpt-5.4"),
    ).toEqual({
      agentRuntimeEngine: "codex_cli",
      codexModel: "gpt-5.4",
      modelOverrides: {
        orchestrator: "openai-codex/gpt-5.4",
        general: "openai-codex/gpt-5.4",
        chronicle: "stella/light",
      },
      assistantPropagatedAgents: ["explore"],
    });
  });

  it("removes engine-owned OpenAI routes when returning to Stella", () => {
    const chatGptPreferences = {
      ...preferences,
      agentRuntimeEngine: "codex_cli" as const,
      modelOverrides: {
        ...preferences.modelOverrides,
        orchestrator: "openai-codex/gpt-5.4",
        general: "openai-codex/gpt-5.4",
      },
    };

    expect(buildEngineRoutingPatch(chatGptPreferences, "default")).toEqual({
      agentRuntimeEngine: "default",
      modelOverrides: { chronicle: "stella/light" },
      assistantPropagatedAgents: ["explore"],
    });
  });

  it("stores Claude Code's model without writing unroutable provider ids", () => {
    expect(
      buildEngineRoutingPatch(preferences, "claude_code_local", "opus"),
    ).toEqual({
      agentRuntimeEngine: "claude_code_local",
      claudeCodeModel: "opus",
      modelOverrides: preferences.modelOverrides,
      assistantPropagatedAgents: ["explore"],
    });
  });

  it("uses engine-specific reasoning storage for ChatGPT and Claude Code", () => {
    const reasoningPreferences = {
      reasoningEfforts: {
        orchestrator: "low" as const,
        general: "low" as const,
      },
      codexReasoningEffort: "default" as const,
      claudeCodeReasoningEffort: "default" as const,
    };

    expect(
      buildEngineReasoningPatch(reasoningPreferences, "codex_cli", "high", [
        "orchestrator",
        "general",
      ]),
    ).toEqual({
      reasoningEfforts: { orchestrator: "high" },
      codexReasoningEffort: "high",
    });
    expect(
      buildEngineReasoningPatch(
        reasoningPreferences,
        "claude_code_local",
        "xhigh",
        ["orchestrator", "general"],
      ),
    ).toEqual({
      reasoningEfforts: {},
      claudeCodeReasoningEffort: "xhigh",
    });
  });
});
