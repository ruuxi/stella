import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../../../src/global/settings/lib/model-catalog";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  DEFAULT_CHATGPT_MODEL,
  intersectChatGptModels,
  listChatGptCatalogModels,
} from "../../../src/global/settings/lib/engine-model-routing";
import { DEFAULT_CODEX_MODEL } from "../../../../runtime/contracts/agent-engine";

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
  stellaConversationModelOverrides: {},
  assistantPropagatedAgents: ["general", "explore"],
  agentRuntimeEngine: "default" as const,
  codexModel: "gpt-5.4",
  claudeCodeModel: "sonnet",
};

describe("engine model routing", () => {
  it("uses the runtime contract as the single ChatGPT default", () => {
    expect(DEFAULT_CHATGPT_MODEL).toBe(DEFAULT_CODEX_MODEL);
  });
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

  it("only shows models present in both the registry and live Codex list", () => {
    const models = [
      catalogModel("openai-codex", "gpt-5.4"),
      catalogModel("openai-codex", "gpt-5.4-mini"),
    ];
    expect(
      intersectChatGptModels(models, [
        { id: "gpt-5.4", hidden: false },
        { id: "gpt-5.4-mini", hidden: true },
        { id: "future-model", hidden: false },
      ]).map((model) => model.modelId),
    ).toEqual(["gpt-5.4"]);
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
      stellaConversationModelOverrides: {
        orchestrator: "anthropic/claude-opus-4.8",
        general: "anthropic/claude-opus-4.8",
      },
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
      stellaConversationModelOverrides: {},
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
      stellaConversationModelOverrides: {
        orchestrator: "anthropic/claude-opus-4.8",
        general: "anthropic/claude-opus-4.8",
      },
      assistantPropagatedAgents: ["explore"],
    });
  });

  it("uses engine-specific reasoning storage for ChatGPT and Claude Code", () => {
    const reasoningPreferences = {
      agentRuntimeEngine: "default" as const,
      reasoningEfforts: {
        orchestrator: "low" as const,
        general: "low" as const,
      },
      stellaConversationReasoningEfforts: {},
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

  it("restores Stella reasoning after a ChatGPT round trip", () => {
    const base = {
      agentRuntimeEngine: "default" as const,
      reasoningEfforts: {
        orchestrator: "low" as const,
        general: "low" as const,
      },
      stellaConversationReasoningEfforts: {},
      codexReasoningEffort: "high" as const,
      claudeCodeReasoningEffort: "default" as const,
    };
    const entering = buildEngineTransitionReasoningPatch(base, "codex_cli");
    expect(entering).toEqual({
      reasoningEfforts: { orchestrator: "high" },
      stellaConversationReasoningEfforts: {
        orchestrator: "low",
        general: "low",
      },
    });
    expect(
      buildEngineTransitionReasoningPatch(
        { ...base, ...entering, agentRuntimeEngine: "codex_cli" },
        "default",
      ),
    ).toEqual({
      reasoningEfforts: { orchestrator: "low", general: "low" },
      stellaConversationReasoningEfforts: {
        orchestrator: "low",
        general: "low",
      },
    });
  });

  it("migrates legacy Claude routes and reasoning before leaving the engine", () => {
    const legacyClaude = {
      ...preferences,
      agentRuntimeEngine: "claude_code_local" as const,
      stellaConversationModelOverrides: {},
    };
    expect(buildEngineRoutingPatch(legacyClaude, "default")).toMatchObject({
      agentRuntimeEngine: "default",
      modelOverrides: preferences.modelOverrides,
      stellaConversationModelOverrides: {
        orchestrator: "anthropic/claude-opus-4.8",
        general: "anthropic/claude-opus-4.8",
      },
    });

    const reasoning = buildEngineTransitionReasoningPatch(
      {
        agentRuntimeEngine: "claude_code_local",
        reasoningEfforts: {
          orchestrator: "medium",
          general: "low",
        },
        stellaConversationReasoningEfforts: {},
        codexReasoningEffort: "default",
        claudeCodeReasoningEffort: "high",
      },
      "default",
    );
    expect(reasoning).toEqual({
      reasoningEfforts: { orchestrator: "medium", general: "low" },
      stellaConversationReasoningEfforts: {
        orchestrator: "medium",
        general: "low",
      },
    });
  });
});
