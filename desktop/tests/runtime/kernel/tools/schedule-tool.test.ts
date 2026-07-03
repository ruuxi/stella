import { describe, expect, it } from "vitest";

import {
  handleSchedule,
  type ScheduleWaitPolicy,
} from "../../../../../runtime/kernel/tools/schedule.js";
import { LocalAgentManager } from "../../../../../runtime/kernel/agents/local-agent-manager.js";
import type {
  AgentToolApi,
  AgentToolSnapshot,
  ToolContext,
  ToolResult,
} from "../../../../../runtime/kernel/tools/types.js";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const args = { prompt: "Set up a daily 9am check-in" };

const makeAgentApi = (
  snapshots: () => AgentToolSnapshot,
): AgentToolApi & { canceled: string[] } => {
  const canceled: string[] = [];
  return {
    canceled,
    createAgent: async () => ({ threadId: "thread-1" }),
    getAgent: async () => snapshots(),
    cancelAgent: async (threadId: string) => {
      canceled.push(threadId);
      return { canceled: true };
    },
  };
};

const runningSnapshot = (
  recentActivity?: string[],
  lastActivityAt?: number,
  activeToolCount?: number,
): AgentToolSnapshot => ({
  id: "thread-1",
  status: "running",
  description: "Apply local scheduling changes",
  startedAt: Date.now(),
  completedAt: null,
  ...(recentActivity ? { recentActivity } : {}),
  ...(typeof lastActivityAt === "number" ? { lastActivityAt } : {}),
  ...(typeof activeToolCount === "number" ? { activeToolCount } : {}),
});

const fastPolicy = (
  overrides: Partial<ScheduleWaitPolicy> = {},
): ScheduleWaitPolicy => ({
  maxWaitMs: 500,
  idleTimeoutMs: 120,
  pollMs: 5,
  ...overrides,
});

describe("handleSchedule wait policy", () => {
  it("returns the subagent result when it completes", async () => {
    let polls = 0;
    const api = makeAgentApi(() => {
      polls += 1;
      if (polls < 3) return runningSnapshot();
      return {
        ...runningSnapshot(),
        status: "completed",
        completedAt: Date.now(),
        result: "Created daily 9am cron.",
      };
    });

    const result = await handleSchedule(
      api,
      undefined,
      args,
      context,
      fastPolicy(),
    );
    expect(result.result).toBe("Created daily 9am cron.");
    expect(api.canceled).toEqual([]);
  });

  it("keeps waiting past the idle window while activity keeps changing", async () => {
    const start = Date.now();
    let polls = 0;
    const api = makeAgentApi(() => {
      polls += 1;
      // Complete only well after the idle window would have tripped for a
      // silent agent; activity changes every poll so the idle clock resets.
      if (Date.now() - start > 250) {
        return {
          ...runningSnapshot(),
          status: "completed",
          completedAt: Date.now(),
          result: "Done after long active run.",
        };
      }
      return runningSnapshot([`step ${polls}`]);
    });

    const result = await handleSchedule(
      api,
      undefined,
      args,
      context,
      fastPolicy({ idleTimeoutMs: 100, maxWaitMs: 2_000 }),
    );
    expect(result.result).toBe("Done after long active run.");
    expect(api.canceled).toEqual([]);
  });

  it("stays alive through one slow tool call: static stamp, tool in flight", async () => {
    // Faithful to LocalAgentManager mid-tool: lastActivityAt was stamped
    // once at tool start and does NOT move while the tool runs; the only
    // liveness signal is activeToolCount > 0. The tool outlasts the idle
    // window several times over.
    const start = Date.now();
    const stampAtToolStart = Date.now();
    const api = makeAgentApi(() => {
      if (Date.now() - start > 350) {
        return {
          ...runningSnapshot(),
          status: "completed",
          completedAt: Date.now(),
          result: "Cron created after slow connector probe.",
        };
      }
      return runningSnapshot(["Running exec_command"], stampAtToolStart, 1);
    });

    const result = await handleSchedule(
      api,
      undefined,
      args,
      context,
      fastPolicy({ idleTimeoutMs: 100, maxWaitMs: 2_000 }),
    );
    expect(result.result).toBe("Cron created after slow connector probe.");
    expect(api.canceled).toEqual([]);
  });

  it("cancels on a static stamp once no tool is in flight", async () => {
    // Same static stamp, but activeToolCount is 0 — a genuinely idle agent
    // (e.g. wedged between turns) still gets cancelled after the idle window.
    const staleStamp = Date.now();
    const api = makeAgentApi(() =>
      runningSnapshot(["Running exec_command"], staleStamp, 0),
    );

    await expect(
      handleSchedule(api, undefined, args, context, fastPolicy()),
    ).rejects.toThrow("Scheduling request timed out.");
    expect(api.canceled).toEqual(["thread-1"]);
  });

  it("cancels when lastActivityAt goes stale even if recentActivity churns", async () => {
    // lastActivityAt is authoritative when present: a frozen stamp means
    // idle, regardless of cosmetic recentActivity changes.
    const staleStamp = Date.now();
    let polls = 0;
    const api = makeAgentApi(() => {
      polls += 1;
      return runningSnapshot([`cosmetic ${polls}`], staleStamp);
    });

    await expect(
      handleSchedule(api, undefined, args, context, fastPolicy()),
    ).rejects.toThrow("Scheduling request timed out.");
    expect(api.canceled).toEqual(["thread-1"]);
  });

  it("returns the result when the agent completes right as the cancel lands", async () => {
    let canceled = false;
    const api = makeAgentApi(() =>
      canceled
        ? {
            ...runningSnapshot(),
            status: "completed",
            completedAt: Date.now(),
            result: "Finished during cancellation race.",
          }
        : runningSnapshot(["stuck on one step"]),
    );
    const innerCancel = api.cancelAgent;
    api.cancelAgent = async (threadId: string, reason?: string) => {
      canceled = true;
      return innerCancel(threadId, reason);
    };

    const result = await handleSchedule(
      api,
      undefined,
      args,
      context,
      fastPolicy(),
    );
    expect(result.result).toBe("Finished during cancellation race.");
  });

  it("cancels the subagent after sustained inactivity", async () => {
    const api = makeAgentApi(() => runningSnapshot(["stuck on one step"]));

    await expect(
      handleSchedule(api, undefined, args, context, fastPolicy()),
    ).rejects.toThrow("Scheduling request timed out.");
    expect(api.canceled).toEqual(["thread-1"]);
  });

  it("cancels at the hard cap even when activity keeps changing", async () => {
    let polls = 0;
    const api = makeAgentApi(() => {
      polls += 1;
      return runningSnapshot([`step ${polls}`]);
    });

    await expect(
      handleSchedule(
        api,
        undefined,
        args,
        context,
        fastPolicy({ maxWaitMs: 150, idleTimeoutMs: 10_000 }),
      ),
    ).rejects.toThrow("Scheduling request timed out.");
    expect(api.canceled).toEqual(["thread-1"]);
  });

  it("survives a real LocalAgentManager run whose single tool outlasts the idle window", async () => {
    // End-to-end contract test: the genuine manager (not a hand-rolled
    // snapshot) runs a subagent whose only activity is one tool call that
    // takes ~3x the idle window, with zero streamed progress. The static
    // mid-tool lastActivityAt must not get the agent cancelled.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (runArgs) => {
        runArgs.onToolStart?.({
          runId: runArgs.runId,
          seq: 1,
          toolCallId: "call-1",
          toolName: "exec_command",
          statusText: "Running exec_command",
        });
        await sleep(300);
        runArgs.onToolEnd?.({
          runId: runArgs.runId,
          seq: 2,
          toolCallId: "call-1",
          toolName: "exec_command",
          resultPreview: "ok",
        });
        return { runId: runArgs.runId, result: "Cron created." };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });
    const canceled: string[] = [];
    const api: AgentToolApi = {
      createAgent: (request) => manager.createAgent(request),
      getAgent: (threadId) => manager.getAgent(threadId),
      cancelAgent: async (threadId, reason) => {
        canceled.push(threadId);
        return manager.cancelAgent(threadId, reason);
      },
    };

    const result = await handleSchedule(
      api,
      undefined,
      args,
      context,
      fastPolicy({ idleTimeoutMs: 100, maxWaitMs: 2_000, pollMs: 10 }),
    );
    expect(result.result).toBe("Cron created.");
    expect(canceled).toEqual([]);
  });

  it("surfaces subagent errors instead of timing out", async () => {
    const api = makeAgentApi(() => ({
      ...runningSnapshot(),
      status: "error",
      error: "Cron store unavailable.",
    }));

    await expect(
      handleSchedule(api, undefined, args, context, fastPolicy()),
    ).rejects.toThrow("Cron store unavailable.");
    expect(api.canceled).toEqual([]);
  });
});
