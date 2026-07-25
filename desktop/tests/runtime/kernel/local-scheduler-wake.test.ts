import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalSchedulerService } from "../../../../runtime/kernel/local-scheduler-service.js";
import type { StellaHostRunnerTarget } from "../../../../runtime/kernel/lifecycle-targets.js";
import { handleWakeWhen } from "../../../../runtime/kernel/tools/wake.js";
import type {
  ScheduleToolApi,
  ToolContext,
} from "../../../../runtime/kernel/tools/types.js";

type AutomationCall = {
  conversationId: string;
  userPrompt: string;
  agentType?: string;
};

type SendInputCall = {
  threadId: string;
  message: string;
};

const makeRunnerTarget = (
  automation: AutomationCall[],
  sendInput: SendInputCall[],
  options: { deliverInput?: boolean } = {},
): StellaHostRunnerTarget => ({
  getRunner: () => ({
    runAutomationTurn: async (payload) => {
      automation.push(payload as AutomationCall);
      return { status: "ok", finalText: "" };
    },
    getActiveOrchestratorRun: () => null,
    sendAgentInput: async (payload) => {
      sendInput.push({ threadId: payload.threadId, message: payload.message });
      return { delivered: options.deliverInput !== false };
    },
  }),
});

type SchedulerInternals = {
  runDueItems: () => Promise<void>;
  timer: NodeJS.Timeout | null;
  state: { cronJobs: { nextRunAtMs: number }[] };
};

/**
 * Disarm the wall-clock timer while leaving the service started, so the
 * tests own when ticks happen. `stop()` would also flip `started`, which
 * makes `runDueItems` a no-op.
 */
const freeze = (scheduler: LocalSchedulerService) => {
  const internal = scheduler as unknown as SchedulerInternals;
  if (internal.timer) clearTimeout(internal.timer);
  internal.timer = null;
};

/**
 * Advance to "one poll happens now": pull every job's next run forward and
 * drain, rather than sleeping out real interval seconds.
 */
const tick = async (scheduler: LocalSchedulerService) => {
  const internal = scheduler as unknown as SchedulerInternals;
  for (const job of internal.state.cronJobs) job.nextRunAtMs = Date.now();
  await internal.runDueItems();
  freeze(scheduler);
};

const startFrozen = (scheduler: LocalSchedulerService) => {
  scheduler.start();
  freeze(scheduler);
  return scheduler;
};

describe("condition-gated cron jobs (the durable wake primitive)", () => {
  let dataDir: string;
  let automation: AutomationCall[];
  let sendInput: SendInputCall[];
  let scheduler: LocalSchedulerService;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-wake-"));
    automation = [];
    sendInput = [];
    scheduler = new LocalSchedulerService({
      stellaDataDir: dataDir,
      runnerTarget: makeRunnerTarget(automation, sendInput),
    });
    startFrozen(scheduler);
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const armWake = (
    condition: string,
    overrides: Partial<Parameters<LocalSchedulerService["addCronJob"]>[0]> = {},
  ) =>
    scheduler.addCronJob({
      name: "wake",
      conversationId: "conv-1",
      schedule: { kind: "every", everyMs: 1_000 },
      condition: { kind: "command", command: condition },
      expiresAtMs: Date.now() + 60_000,
      payload: { kind: "agent", prompt: "continue the sweep" },
      deleteAfterRun: true,
      deliver: false,
      ...overrides,
    });

  it("does not fire, notify, or bill a turn while the condition is false", async () => {
    const job = armWake("exit 1");

    await tick(scheduler);

    expect(automation).toEqual([]);
    expect(sendInput).toEqual([]);
    const after = scheduler.listCronJobs().find((entry) => entry.id === job.id);
    expect(after?.enabled).toBe(true);
    expect(after?.lastStatus).toBe("waiting");
    expect(after?.conditionChecks).toBe(1);
    // A skipped check is not a run.
    expect(after?.lastRunAtMs).toBeUndefined();
  });

  it("fires once the condition passes and retires the watcher", async () => {
    const marker = path.join(dataDir, "done");
    const job = armWake(`test -f ${JSON.stringify(marker)}`);

    await tick(scheduler);
    expect(automation).toEqual([]);

    fs.writeFileSync(marker, "");
    await tick(scheduler);

    expect(automation).toHaveLength(1);
    expect(automation[0].conversationId).toBe("conv-1");
    expect(automation[0].userPrompt).toContain("continue the sweep");
    expect(automation[0].userPrompt).toContain(
      "the condition you armed is now true",
    );

    // deleteAfterRun retires it, so a later tick cannot re-wake the thread.
    expect(
      scheduler.listCronJobs().find((entry) => entry.id === job.id),
    ).toBeUndefined();
    await tick(scheduler);
    expect(automation).toHaveLength(1);
  });

  it("passes the check's stdout through so the agent can read what it waited for", async () => {
    armWake('echo \'POD_JSON {"id":"abc"}\'');

    await tick(scheduler);

    expect(automation).toHaveLength(1);
    expect(automation[0].userPrompt).toContain('POD_JSON {"id":"abc"}');
  });

  it("wakes anyway when the deadline passes, flagged as unsatisfied", async () => {
    armWake("exit 1", { expiresAtMs: Date.now() - 1 });

    await tick(scheduler);

    expect(automation).toHaveLength(1);
    expect(automation[0].userPrompt).toContain("timed out");
    expect(automation[0].userPrompt).toContain("never became true");
  });

  it("resumes the arming agent thread instead of starting a stranger", async () => {
    armWake("exit 0", {
      payload: {
        kind: "agent",
        prompt: "continue the sweep",
        threadId: "thread-7",
      },
    });

    await tick(scheduler);

    expect(sendInput).toHaveLength(1);
    expect(sendInput[0].threadId).toBe("thread-7");
    expect(sendInput[0].message).toContain("continue the sweep");
    expect(automation).toEqual([]);
  });

  it("falls back to a fresh turn when the arming thread is gone", async () => {
    scheduler.stop();
    scheduler = startFrozen(
      new LocalSchedulerService({
        stellaDataDir: dataDir,
        runnerTarget: makeRunnerTarget(automation, sendInput, {
          deliverInput: false,
        }),
      }),
    );
    armWake("exit 0", {
      payload: {
        kind: "agent",
        prompt: "continue the sweep",
        threadId: "thread-gone",
      },
    });

    await tick(scheduler);

    expect(sendInput).toHaveLength(1);
    expect(automation).toHaveLength(1);
    expect(automation[0].userPrompt).toContain("continue the sweep");
  });

  it("survives a restart: the wait is on disk, not in the session", async () => {
    const marker = path.join(dataDir, "later");
    armWake(`test -f ${JSON.stringify(marker)}`);
    scheduler.stop();

    const revived = startFrozen(
      new LocalSchedulerService({
        stellaDataDir: dataDir,
        runnerTarget: makeRunnerTarget(automation, sendInput),
      }),
    );
    try {
      expect(revived.listCronJobs()).toHaveLength(1);
      fs.writeFileSync(marker, "");
      await tick(revived);
      expect(automation).toHaveLength(1);
    } finally {
      revived.stop();
    }
  });

  it("keeps polling, and keeps other crons draining, while the worker is down", async () => {
    scheduler.stop();
    scheduler = startFrozen(
      new LocalSchedulerService({
        stellaDataDir: dataDir,
        // No worker: a plain agent cron would stall the whole drain here.
        runnerTarget: { getRunner: () => null },
      }),
    );
    const wake = armWake("exit 1");
    const notify = scheduler.addCronJob({
      name: "plain",
      conversationId: "conv-1",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "notify", text: "still here" },
    });

    await tick(scheduler);

    const jobs = scheduler.listCronJobs();
    expect(jobs.find((entry) => entry.id === wake.id)?.conditionChecks).toBe(1);
    expect(jobs.find((entry) => entry.id === notify.id)?.lastStatus).toBe("ok");
  });

  it("leaves unconditional recurring jobs on their normal cadence", async () => {
    const job = scheduler.addCronJob({
      name: "plain",
      conversationId: "conv-1",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "notify", text: "hello" },
    });

    await tick(scheduler);

    const after = scheduler.listCronJobs().find((entry) => entry.id === job.id);
    expect(after?.enabled).toBe(true);
    expect(after?.nextRunAtMs).toBeGreaterThan(Date.now());
  });
});

describe("WakeWhen tool", () => {
  let dataDir: string;
  let scheduler: LocalSchedulerService;
  let scheduleApi: ScheduleToolApi;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-wake-tool-"));
    scheduler = new LocalSchedulerService({
      stellaDataDir: dataDir,
      runnerTarget: makeRunnerTarget([], []),
    });
    startFrozen(scheduler);
    scheduleApi = {
      listCronJobs: async () => scheduler.listCronJobs(),
      addCronJob: async (input) => scheduler.addCronJob(input),
      updateCronJob: async (jobId, patch) =>
        scheduler.updateCronJob(jobId, patch),
      removeCronJob: async (jobId) => scheduler.removeCronJob(jobId),
      runCronJob: async (jobId) => scheduler.runCronJob(jobId),
      getHeartbeatConfig: async (conversationId) =>
        scheduler.getHeartbeatConfig(conversationId),
      upsertHeartbeat: async (input) => scheduler.upsertHeartbeat(input),
      runHeartbeat: async (conversationId) =>
        scheduler.runHeartbeat(conversationId),
    };
  });

  afterEach(() => {
    scheduler.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const context: ToolContext = {
    conversationId: "conv-1",
    deviceId: "d1",
    requestId: "r1",
    agentType: "general",
    agentId: "thread-7",
  };

  it("registers a one-shot watcher pinned to the calling thread", async () => {
    const result = await handleWakeWhen(
      scheduleApi,
      { when: "test -f /tmp/done", then: "resume the sweep" },
      context,
    );

    expect(result.error).toBeUndefined();
    const [job] = scheduler.listCronJobs();
    expect(job.condition).toEqual({
      kind: "command",
      command: "test -f /tmp/done",
    });
    expect(job.payload).toMatchObject({
      kind: "agent",
      prompt: "resume the sweep",
      agentType: "general",
      threadId: "thread-7",
    });
    expect(job.deleteAfterRun).toBe(true);
    expect(job.deliver).toBe(false);
    expect(job.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("clamps a hot poll rate to something a process spawn can sustain", async () => {
    await handleWakeWhen(
      scheduleApi,
      { when: "true", then: "go", pollSeconds: 0.1 },
      context,
    );

    const [job] = scheduler.listCronJobs();
    expect(job.schedule).toEqual({ kind: "every", everyMs: 10_000 });
  });

  it("refuses a wake with no follow-up instructions", async () => {
    const result = await handleWakeWhen(scheduleApi, { when: "true" }, context);

    expect(result.error).toContain("`then` is required");
    expect(scheduler.listCronJobs()).toHaveLength(0);
  });
});
