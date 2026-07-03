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
  lastActivityAt?: number,
): AgentToolSnapshot => ({
  id: "thread-1",
  status: "running",
  description: "Apply local scheduling changes",
  startedAt: Date.now(),
  completedAt: null,
  ...(recentActivity ? { recentActivity } : {}),
  ...(typeof lastActivityAt === "number" ? { lastActivityAt } : {}),
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

  it("stays alive through one slow tool call via lastActivityAt, with static recentActivity", async () => {
    // Simulates LocalAgentManager during a single long-running tool: the
    // display string never changes, but the liveness stamp keeps moving
    // (tool start already bumped it; here we refresh it each poll as the
    // manager does on tool start/end).
    const start = Date.now();
    const api = makeAgentApi(() => {
      if (Date.now() - start > 250) {
        return {
          ...runningSnapshot(),
          status: "completed",
          completedAt: Date.now(),
          result: "Cron created after slow connector probe.",
        };
      }
      return runningSnapshot(["Running exec_command"], Date.now());
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
