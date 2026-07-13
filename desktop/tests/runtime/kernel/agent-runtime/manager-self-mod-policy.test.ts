import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGER_OWNED_SELF_MOD_ERROR_CODE,
  ManagerOwnedSelfModError,
} from "../../../../../runtime/kernel/agents/manager-self-mod-policy.js";

const externalRuntime = vi.hoisted(() => ({
  willRun: true,
  runSubagent: vi.fn(),
}));

vi.mock(
  "../../../../../runtime/kernel/agent-runtime/external-engines.js",
  () => ({
    willRunExternalSubagentEngine: () => externalRuntime.willRun,
    runExternalSubagentTurn: externalRuntime.runSubagent,
    runExternalOrchestratorTurn: vi.fn(),
    shutdownExternalEngineIntegrations: vi.fn(),
  }),
);

import { runSubagentTask } from "../../../../../runtime/kernel/agent-runtime.js";

describe("manager-owned external engine policy", () => {
  beforeEach(() => {
    externalRuntime.willRun = true;
    externalRuntime.runSubagent.mockReset();
  });

  it("raises the typed self-mod policy error before an external engine starts", async () => {
    const error = await runSubagentTask({ managerOwned: true } as never).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(ManagerOwnedSelfModError);
    expect(error).toMatchObject({ code: MANAGER_OWNED_SELF_MOD_ERROR_CODE });
    expect(error.message).toContain("directly from the orchestrator");
    expect(externalRuntime.runSubagent).not.toHaveBeenCalled();
  });

  it("does not change direct external subagent routing", async () => {
    externalRuntime.runSubagent.mockResolvedValue({
      runId: "direct-run",
      result: "done",
    });

    await expect(
      runSubagentTask({ managerOwned: false } as never),
    ).resolves.toEqual({ runId: "direct-run", result: "done" });
    expect(externalRuntime.runSubagent).toHaveBeenCalledTimes(1);
  });
});
