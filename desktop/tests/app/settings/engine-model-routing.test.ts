import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../../../src/global/settings/lib/model-catalog";
import {
  buildEngineReasoningPatch,
  buildEngineRoutingPatch,
  buildEngineTransitionReasoningPatch,
  DEFAULT_CHATGPT_MODEL,
  intersectChatGptModels,
  listChatGptCatalogModels,
  resolveChatGptEngineModel,
  resolveChatGptModelSelection,
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

  describe("resolveChatGptModelSelection auto-match", () => {
    const available = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"];
    it("keeps the requested model when it is available", () => {
      expect(
        resolveChatGptModelSelection("gpt-5.5", available, "gpt-5.6-sol"),
      ).toBe("gpt-5.5");
    });
    it("falls back to the default when the request is unavailable", () => {
      expect(
        resolveChatGptModelSelection("gpt-5.4-mini", available, "gpt-5.6-sol"),
      ).toBe("gpt-5.6-sol");
    });
    it("falls back to the first available model when neither matches", () => {
      expect(
        resolveChatGptModelSelection("gpt-5.4-mini", available, "legacy"),
      ).toBe("gpt-5.6-sol");
    });
    it("resolves the default even when no model was requested", () => {
      expect(
        resolveChatGptModelSelection(undefined, available, "gpt-5.5"),
      ).toBe("gpt-5.5");
    });
    it("returns null only when the catalog is empty", () => {
      expect(resolveChatGptModelSelection("gpt-5.5", [], "gpt-5.6-sol")).toBe(
        null,
      );
    });
  });

  describe("resolveChatGptEngineModel classification", () => {
    const liveIds = ["gpt-5.6-sol", "gpt-5.4"];
    const registryIds = ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
    it("keeps a saved model present in the live list", () => {
      expect(
        resolveChatGptEngineModel(
          "gpt-5.4",
          liveIds,
          registryIds,
          "gpt-5.6-sol",
        ),
      ).toEqual({ kind: "available", modelId: "gpt-5.4" });
    });
    it("keeps a registry-routable model missing from a flaky live list", () => {
      // gpt-5.5 is a real model temporarily absent from model/list; do NOT
      // silently reroute the user off it.
      expect(
        resolveChatGptEngineModel(
          "gpt-5.5",
          liveIds,
          registryIds,
          "gpt-5.6-sol",
        ),
      ).toEqual({ kind: "transient-gap", modelId: "gpt-5.5" });
    });
    it("reroutes only when the saved model is gone from both sources", () => {
      expect(
        resolveChatGptEngineModel(
          "gpt-4o-legacy",
          liveIds,
          registryIds,
          "gpt-5.6-sol",
        ),
      ).toEqual({
        kind: "rerouted",
        modelId: "gpt-5.6-sol",
        savedModel: "gpt-4o-legacy",
      });
    });
    it("reports unavailable when the live list is empty and model is gone", () => {
      expect(
        resolveChatGptEngineModel("gpt-4o-legacy", [], [], "gpt-5.6-sol"),
      ).toEqual({ kind: "unavailable" });
    });
    it("treats a transient gap even when the live list is empty", () => {
      // A total live-list failure must not evict a registry-routable saved id.
      expect(
        resolveChatGptEngineModel("gpt-5.5", [], registryIds, "gpt-5.6-sol"),
      ).toEqual({ kind: "transient-gap", modelId: "gpt-5.5" });
    });
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

  it("fills each missing legacy snapshot key without replacing existing keys", () => {
    const partialClaude = {
      ...preferences,
      agentRuntimeEngine: "claude_code_local" as const,
      stellaConversationModelOverrides: {
        orchestrator: "openrouter/existing-orchestrator",
      },
    };
    expect(buildEngineRoutingPatch(partialClaude, "default")).toMatchObject({
      modelOverrides: {
        orchestrator: "openrouter/existing-orchestrator",
        general: "anthropic/claude-opus-4.8",
        chronicle: "stella/light",
      },
      stellaConversationModelOverrides: {
        orchestrator: "openrouter/existing-orchestrator",
        general: "anthropic/claude-opus-4.8",
      },
    });

    expect(
      buildEngineTransitionReasoningPatch(
        {
          agentRuntimeEngine: "claude_code_local",
          reasoningEfforts: {
            orchestrator: "medium",
            general: "low",
          },
          stellaConversationReasoningEfforts: { orchestrator: "high" },
          codexReasoningEffort: "default",
          claudeCodeReasoningEffort: "high",
        },
        "default",
      ),
    ).toEqual({
      reasoningEfforts: { orchestrator: "high", general: "low" },
      stellaConversationReasoningEfforts: {
        orchestrator: "high",
        general: "low",
      },
    });
  });
});
