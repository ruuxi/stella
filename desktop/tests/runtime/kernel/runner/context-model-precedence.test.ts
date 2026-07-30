import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { Model } from "../../../../../runtime/ai/types.js";
import {
  captureEffectiveModelConfig,
  resolveAgentEngineForRun,
  resolveSpawnReasoningEffortForModel,
} from "../../../../../runtime/kernel/runner/context.js";
import type { ResolvedLlmRoute } from "../../../../../runtime/kernel/model-routing.js";
import { updateLocalModelPreferences } from "../../../../../runtime/kernel/preferences/local-preferences.js";

describe("spawn_agent engine precedence", () => {
  it("lets an explicit plain-model spawn override a saved Codex engine", () => {
    expect(resolveAgentEngineForRun("codex_cli", { engine: "default" })).toBe(
      "default",
    );
  });

  it("lets an explicit plain-model spawn override a saved Claude Code engine", () => {
    expect(
      resolveAgentEngineForRun("claude_code_local", { engine: "default" }),
    ).toBe("default");
  });

  it("uses the saved engine only when the spawn has no explicit selection", () => {
    expect(resolveAgentEngineForRun("codex_cli")).toBe("codex_cli");
  });

  it("lets an explicit external engine override the saved engine", () => {
    expect(
      resolveAgentEngineForRun("codex_cli", {
        engine: "claude_code_local",
        model: "opus",
      }),
    ).toBe("claude_code_local");
  });
});

describe("spawn_agent Stella reasoning clamping", () => {
  const model = (
    reasoning: boolean,
    thinkingLevelMap?: Model<any>["thinkingLevelMap"],
  ) => ({ reasoning, thinkingLevelMap }) as Model<any>;

  it("clamps to the nearest supported model effort", () => {
    const mediumHighOnly = model(true, {
      off: null,
      minimal: null,
      low: null,
      xhigh: null,
    });
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "low")).toBe(
      "medium",
    );
    expect(resolveSpawnReasoningEffortForModel(mediumHighOnly, "xhigh")).toBe(
      "high",
    );

    const lowXhighOnly = model(true, {
      off: null,
      minimal: null,
      medium: null,
      high: null,
      xhigh: "xhigh",
    });
    expect(resolveSpawnReasoningEffortForModel(lowXhighOnly, "medium")).toBe(
      "low",
    );
    expect(resolveSpawnReasoningEffortForModel(lowXhighOnly, "high")).toBe(
      "xhigh",
    );

    const lowHighOnly = model(true, {
      off: null,
      minimal: null,
      medium: null,
      xhigh: null,
    });
    expect(resolveSpawnReasoningEffortForModel(lowHighOnly, "medium")).toBe(
      "high",
    );
  });

  it("drops a spawn effort when the resolved model has no dial", () => {
    expect(
      resolveSpawnReasoningEffortForModel(model(false), "high"),
    ).toBeUndefined();
  });
});

describe("spawn_agent model inheritance snapshots", () => {
  const stellaRoute = (id: string): ResolvedLlmRoute =>
    ({
      model: { id, provider: "stella" },
      route: "stella",
      getApiKey: () => "test-key",
    }) as ResolvedLlmRoute;

  it("pins an explicit Stella Orchestrator turn to its resolved model and effort", () => {
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-spawn-inheritance",
        engine: "default",
        configuredModel: "stella/max",
        resolvedLlm: stellaRoute("openai/gpt-5.6-sol"),
        reasoningEffort: "xhigh",
      }),
    ).toEqual({
      engine: "default",
      routeModel: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
  });

  it("pins the concrete model selected by a saved/default Orchestrator route", () => {
    const resolvedDefault = stellaRoute("default");
    (
      resolvedDefault.model as ResolvedLlmRoute["model"] & {
        upstreamModelId?: string;
      }
    ).upstreamModelId = "muse-spark-1.1";
    resolvedDefault.toolPolicyModel = {
      id: "meta/muse-spark-1.1",
      provider: "meta",
      api: "openai-completions",
      name: "Muse Spark 1.1",
    };
    expect(
      captureEffectiveModelConfig({
        stellaDataDir: "/tmp/stella-spawn-inheritance",
        engine: "default",
        resolvedLlm: resolvedDefault,
        reasoningEffort: "low",
      }),
    ).toEqual({
      engine: "default",
      routeModel: "stella/meta/muse-spark-1.1",
      reasoningEffort: "low",
    });
  });

  it("pins an explicit Codex spawn while inheriting the selected Fast speed", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-codex-spawn-inheritance-"),
    );
    try {
      updateLocalModelPreferences(stellaDataDir, {
        codexServiceTier: "fast",
      });
      expect(
        captureEffectiveModelConfig({
          stellaDataDir,
          engine: "codex_cli",
          configuredModel: "stella/standard",
          engineModelOverride: "gpt-5.6-codex",
          resolvedLlm: stellaRoute("meta/muse-spark-1.1"),
          reasoningEffort: "high",
        }),
      ).toEqual({
        engine: "codex_cli",
        routeModel: "stella/meta/muse-spark-1.1",
        engineModel: "gpt-5.6-codex",
        reasoningEffort: "high",
        serviceTier: "fast",
      });
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });
});
