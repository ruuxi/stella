import { describe, expect, it } from "vitest";

import { AGENT_STREAM_EVENT_TYPES } from "../../../runtime/contracts/agent-runtime.js";
import {
  reduceTaskSnapshot,
  type ConversationTaskSnapshot,
} from "../../electron/ipc/task-snapshot-reducer.js";

const RUN_ID = "run-1";
const AGENT_ID = "agent-1";

const reduce = (
  current: ConversationTaskSnapshot | undefined,
  type: string,
  nowMs: number,
  extra: Partial<Parameters<typeof reduceTaskSnapshot>[0]["event"]> = {},
) =>
  reduceTaskSnapshot({
    current,
    event: { type, ...extra },
    runId: RUN_ID,
    agentId: AGENT_ID,
    nowMs,
  });

describe("reduceTaskSnapshot completedAtMs lifecycle", () => {
  it("stamps completedAtMs when a run first completes", () => {
    const started = reduce(undefined, AGENT_STREAM_EVENT_TYPES.AGENT_STARTED, 1_000);
    expect(started?.status).toBe("running");
    expect(started?.completedAtMs).toBeUndefined();

    const completed = reduce(
      started ?? undefined,
      AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
      2_000,
      { result: "done" },
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAtMs).toBe(2_000);
    expect(completed?.startedAtMs).toBe(1_000);
  });

  it("clears the prior completedAtMs when a task genuinely restarts", () => {
    const settled: ConversationTaskSnapshot = {
      runId: RUN_ID,
      agentId: AGENT_ID,
      status: "completed",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
    };

    const revived = reduce(
      settled,
      AGENT_STREAM_EVENT_TYPES.AGENT_STARTED,
      5_000,
    );
    expect(revived?.status).toBe("running");
    expect(revived?.completedAtMs).toBeUndefined();
    // First-seen startedAtMs is preserved across the revive.
    expect(revived?.startedAtMs).toBe(1_000);
  });

  it("clears completedAtMs on restart from an errored terminal state", () => {
    const failed: ConversationTaskSnapshot = {
      runId: RUN_ID,
      agentId: AGENT_ID,
      status: "error",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
    };

    const revived = reduce(failed, AGENT_STREAM_EVENT_TYPES.AGENT_STARTED, 6_000);
    expect(revived?.status).toBe("running");
    expect(revived?.completedAtMs).toBeUndefined();
  });

  it("keeps a settled completedAtMs on a plain terminal re-upsert / hydration re-emit", () => {
    const settled: ConversationTaskSnapshot = {
      runId: RUN_ID,
      agentId: AGENT_ID,
      status: "completed",
      startedAtMs: 1_000,
      completedAtMs: 2_000,
    };

    // Re-emitting the same terminal event (e.g. resume/hydration replay) must
    // not fabricate a fresh completion time.
    const reEmitted = reduce(
      settled,
      AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED,
      9_000,
      { result: "done" },
    );
    expect(reEmitted?.status).toBe("completed");
    expect(reEmitted?.completedAtMs).toBe(2_000);

    // A stale non-terminal feed event against a terminal task is ignored
    // entirely, so the settled snapshot is untouched.
    const ignored = reduce(
      settled,
      AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS,
      9_500,
      { statusText: "late progress" },
    );
    expect(ignored).toBeNull();
  });
});
