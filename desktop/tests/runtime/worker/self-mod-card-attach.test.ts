/**
 * Card attach selection and payload shape.
 *
 * These are the rules that close the background-agent race: a change staged
 * after its turn already ended is still unattached, so the next attach pass
 * (driven by `onPendingApplyStaged`, or by the next assistant reply) picks it
 * up. The payload omits `commitHash` until the commit lands, which is what
 * keeps Undo hidden rather than broken.
 */
import { describe, expect, it } from "vitest";
import {
  buildSelfModCardPayload,
  selectUnattachedPendingCards,
} from "../../../../runtime/worker/self-mod-cards.js";
import type { PendingSelfModApply } from "../../../../runtime/worker/self-mod-coordinator.js";

const emptyApplyResult = {
  appliedRuns: [],
  restartRelevantRunIds: [],
  hasRestartRelevantPaths: false,
  hasRuntimeRestartRelevantPaths: false,
  hasProcessRestartRelevantPaths: false,
  hasFullReloadRelevantPaths: false,
};

const staged = (
  overrides: Partial<PendingSelfModApply> & { applyId: string },
): PendingSelfModApply => ({
  applyResult: emptyApplyResult,
  conversationId: "conv-1",
  files: ["desktop/src/a.tsx"],
  ...overrides,
});

describe("selectUnattachedPendingCards", () => {
  it("returns only this conversation's not-yet-attached changes, in finalize order", () => {
    const pending = [
      staged({ applyId: "run-1" }),
      staged({ applyId: "run-2", conversationId: "conv-other" }),
      staged({ applyId: "run-3", assistantMessageEventId: "evt-existing" }),
      staged({ applyId: "run-4" }),
    ];

    expect(
      selectUnattachedPendingCards(pending, "conv-1").map((e) => e.applyId),
    ).toEqual(["run-1", "run-4"]);
  });

  it("picks up a change staged after the turn ended", () => {
    // The race: at turn end there was nothing to attach. The background run
    // finalizes afterwards, and this pass finds it.
    const pending: PendingSelfModApply[] = [];
    expect(selectUnattachedPendingCards(pending, "conv-1")).toEqual([]);

    pending.push(staged({ applyId: "run-late" }));

    expect(
      selectUnattachedPendingCards(pending, "conv-1").map((e) => e.applyId),
    ).toEqual(["run-late"]);
  });

  it("ignores a blank conversation id", () => {
    expect(
      selectUnattachedPendingCards([staged({ applyId: "r" })], "  "),
    ).toEqual([]);
  });
});

describe("buildSelfModCardPayload", () => {
  it("omits commitHash before the commit lands so Undo stays hidden", () => {
    const payload = buildSelfModCardPayload(staged({ applyId: "run-1" }));

    expect(payload).toEqual({
      applyId: "run-1",
      files: ["desktop/src/a.tsx"],
      batchIndex: 0,
      status: "pending",
    });
    expect("commitHash" in payload).toBe(false);
  });

  it("carries commitHash once the commit has landed", () => {
    const payload = buildSelfModCardPayload(
      staged({ applyId: "run-1", commitHash: "abc123" }),
    );

    expect(payload.commitHash).toBe("abc123");
    expect(payload.applyId).toBe("run-1");
  });
});
