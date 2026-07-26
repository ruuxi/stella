import { describe, expect, it } from "vitest";

import { resolveTierRestrictedModelNotice } from "@/features/chat/hooks/tier-restricted-model-notice";

/**
 * The exact shape a signed-out user on the Claude Code engine carries in
 * `~/.stella/preferences.json`: the engine is committed to Claude Code, and
 * `buildEngineRoutingPatch` has parked the previously selected Stella model
 * back into `modelOverrides` so switching the engine back would restore it.
 * That parked pick must not read as "the user is trying to run stella/max".
 */
const CLAUDE_CODE_PARKED_STELLA_PICK = {
  agentRuntimeEngine: "claude_code_local",
  modelOverrides: {
    orchestrator: "stella/max",
    general: "stella/max",
    dream: "stella/max",
  },
} as const;

describe("tier-restricted model notice", () => {
  it("stays silent on every send while a non-Stella engine is committed", () => {
    expect(
      resolveTierRestrictedModelNotice({
        audience: "anonymous",
        ...CLAUDE_CODE_PARKED_STELLA_PICK,
      }),
    ).toBeNull();

    expect(
      resolveTierRestrictedModelNotice({
        audience: "anonymous",
        agentRuntimeEngine: "codex_cli",
        modelOverrides: { orchestrator: "stella/max", general: "stella/max" },
      }),
    ).toBeNull();
  });

  it("gates the notice by engine for every restricted audience", () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "go_fallback",
    ] as const) {
      expect(
        resolveTierRestrictedModelNotice({
          audience,
          ...CLAUDE_CODE_PARKED_STELLA_PICK,
        }),
      ).toBeNull();
    }
  });

  it("still notifies a signed-out user who selected a Stella model", () => {
    expect(
      resolveTierRestrictedModelNotice({
        audience: "anonymous",
        agentRuntimeEngine: "default",
        modelOverrides: { orchestrator: "stella/max", general: "stella/max" },
      }),
    ).toEqual({
      agent: "orchestrator",
      model: "stella/max",
      modelLabel: "max",
    });
  });

  it("treats a preferences snapshot without an engine as Stella's runtime", () => {
    expect(
      resolveTierRestrictedModelNotice({
        audience: "anonymous",
        agentRuntimeEngine: undefined,
        modelOverrides: { general: "stella/max" },
      }),
    ).toEqual({ agent: "general", model: "stella/max", modelLabel: "max" });
  });

  it("keeps the pre-existing exemptions on Stella's own runtime", () => {
    const onDefaultEngine = (modelOverrides: Record<string, string>) =>
      resolveTierRestrictedModelNotice({
        audience: "anonymous",
        agentRuntimeEngine: "default",
        modelOverrides,
      });

    expect(onDefaultEngine({ orchestrator: "stella/default" })).toBeNull();
    expect(onDefaultEngine({ orchestrator: "stella/standard" })).toBeNull();
    expect(onDefaultEngine({ orchestrator: "stella/light" })).toBeNull();
    expect(
      onDefaultEngine({ orchestrator: "anthropic/claude-opus-4-5" }),
    ).toBeNull();
    expect(onDefaultEngine({})).toBeNull();
  });

  it("never notifies an unrestricted or unknown audience", () => {
    const selectedStellaMax = {
      agentRuntimeEngine: "default",
      modelOverrides: { orchestrator: "stella/max" },
    } as const;

    expect(
      resolveTierRestrictedModelNotice({
        audience: "pro",
        ...selectedStellaMax,
      }),
    ).toBeNull();
    expect(
      resolveTierRestrictedModelNotice({
        audience: null,
        ...selectedStellaMax,
      }),
    ).toBeNull();
  });
});
