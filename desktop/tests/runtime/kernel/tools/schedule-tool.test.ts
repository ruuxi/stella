import { describe, expect, it } from "vitest";

import {
  handleSchedule,
  type ScheduleWaitPolicy,
} from "../../../../../runtime/kernel/tools/schedule.js";
import type {
  AgentToolApi,
  AgentToolSnapshot,
  ToolContext,
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
): AgentToolSnapshot => ({
  id: "thread-1",
  status: "running",
  description: "Apply local scheduling changes",
  startedAt: Date.now(),
  completedAt: null,
  ...(recentActivity ? { recentActivity } : {}),
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
