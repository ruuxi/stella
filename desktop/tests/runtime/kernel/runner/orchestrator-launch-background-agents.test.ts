import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "../../../../../runtime/contracts/agent-runtime.js";
import { startPreparedOrchestratorRun } from "../../../../../runtime/kernel/runner/orchestrator-launch.js";

vi.mock("../../../../../runtime/kernel/runner/model-selection.js", () => ({
  resolveRunnerLlmRouteWithMetadata: vi.fn(async () => ({
    model: { id: "test-model", provider: "test-provider" },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
}));

vi.mock("../../../../../runtime/kernel/agent-runtime.js", () => ({
  runOrchestratorTurn: vi.fn(async (opts: {
    runId: string;
    agentType: string;
    beforeRunEnd?: (args: {
      runId: string;
      threadKey: string;
      finalText: string;
      outcome: "success";
    }) => Promise<void> | void;
    callbacks: {
      onEnd?: (event: {
        runId: string;
        agentType: string;
        seq: number;
        finalText: string;
        timestamp: number;
      }) => void;
    };
  }) => {
    await opts.beforeRunEnd?.({
      runId: opts.runId,
      threadKey: "conversation-1",
      finalText: "spawned",
      outcome: "success",
    });
    opts.callbacks.onEnd?.({
      runId: opts.runId,
      agentType: opts.agentType,
      seq: 1,
      finalText: "spawned",
      timestamp: Date.now(),
    });
  }),
}));

const createContext = () =>
  ({
    state: {
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: null,
      orchestratorSessions: new Map(),
      activeRunAbortControllers: new Map(),
      localAgentManager: {
        listActiveAgentRuns: () => [
          { runId: "run-1", conversationId: "conversation-1" },
        ],
      },
      compactionScheduler: {},
    },
    toolHost: {
      getToolCatalog: () => [],
      executeTool: vi.fn(),
    },
    runtimeStore: {},
    deviceId: "device-1",
    stellaHome: "/tmp/stella-home",
    stellaRoot: "/tmp/stella-root",
  }) as any;

describe("startPreparedOrchestratorRun background agent handling", () => {
  it("does not keep a normal orchestrator turn active until spawned agents finish", async () => {
    const context = createContext();
    const onEnd = vi.fn();
    const cleanupRun = vi.fn((runId: string) => {
      context.state.activeRunAbortControllers.delete(runId);
      context.state.activeOrchestratorRunId = null;
      context.state.activeOrchestratorConversationId = null;
      context.state.activeOrchestratorUiVisibility = "visible";
      context.state.activeOrchestratorSession = null;
    });

    await startPreparedOrchestratorRun({
      context,
      buildAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runId: "run-1",
      conversationId: "conversation-1",
      agentType: AGENT_IDS.ORCHESTRATOR,
      userPrompt: "build this",
      attachments: [],
      userMessageId: "user-message-1",
      createRuntimeCallbacks: () => ({
        onEnd: (event) => {
          cleanupRun(event.runId);
          onEnd(event);
        },
      }),
      cleanupRun,
      onFatalError: vi.fn(),
    });

    await expect(
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("orchestrator run stayed busy")),
          50,
        );
        const check = () => {
          if (onEnd.mock.calls.length > 0) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          setTimeout(check, 1);
        };
        check();
      }),
    ).resolves.toBeUndefined();

    expect(cleanupRun).toHaveBeenCalledWith("run-1");
    expect(context.state.activeOrchestratorRunId).toBeNull();
  });
});
