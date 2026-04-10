import { describe, expect, it } from "vitest";
import { resolveQueuedRunActivation } from "../../src/app/chat/streaming/queued-run-activation";

describe("resolveQueuedRunActivation", () => {
  it("drops a queued run that already finished before activation", () => {
    expect(
      resolveQueuedRunActivation({
        queuedRunId: "run-1",
        activeRunId: null,
        terminalRunIds: new Set(["run-1"]),
      }),
    ).toEqual({ action: "drop" });
  });

  it("backfills metadata when the queued run was already adopted", () => {
    expect(
      resolveQueuedRunActivation({
        queuedRunId: "run-1",
        activeRunId: "run-1",
        terminalRunIds: new Set<string>(),
      }),
    ).toEqual({ action: "backfill" });
  });

  it("waits while another run is still active", () => {
    expect(
      resolveQueuedRunActivation({
        queuedRunId: "run-2",
        activeRunId: "run-1",
        terminalRunIds: new Set<string>(),
      }),
    ).toEqual({ action: "wait" });
  });

  it("activates a queued run when nothing else is active", () => {
    expect(
      resolveQueuedRunActivation({
        queuedRunId: "run-2",
        activeRunId: null,
        terminalRunIds: new Set<string>(),
      }),
    ).toEqual({ action: "activate" });
  });
});
