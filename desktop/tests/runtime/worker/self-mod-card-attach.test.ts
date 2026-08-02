/**
 * Card attach selection and payload shape.
 *
 * These are the publication rules that close the background-agent race: child
 * finalization alone is not eligible for attachment. Its owning General's
 * terminal completion publishes a stable change set, then the orchestrator
 * reply claims that set.
 */
import { describe, expect, it } from "vitest";
import {
  buildSelfModCardPayload,
  claimPublishedSelfModChangeSet,
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
  ownerThreadId: "general-1",
  files: ["desktop/src/a.tsx"],
  ...overrides,
});

describe("buildSelfModCardPayload", () => {
  const publishedSet = (contributions: PendingSelfModApply[]) => {
    for (const contribution of contributions) {
      contribution.changeSetId = "change-set-1";
      contribution.completionEventId = "completion-1";
    }
    return claimPublishedSelfModChangeSet({
      pending: contributions,
      conversationId: "conv-1",
      assistantMessageEventId: "assistant-1",
      completionEventId: "completion-1",
    })!;
  };

  it("omits commitHash before the commit lands so Undo stays hidden", () => {
    const payload = buildSelfModCardPayload(
      publishedSet([staged({ applyId: "run-1" })]),
    );

    expect(payload).toEqual({
      applyId: "change-set-1",
      changeSetId: "change-set-1",
      files: ["desktop/src/a.tsx"],
      batchIndex: 0,
      status: "pending",
    });
    expect("commitHash" in payload).toBe(false);
  });

  it("carries commitHash once the commit has landed", () => {
    const payload = buildSelfModCardPayload(
      publishedSet([staged({ applyId: "run-1", commitHash: "abc123" })]),
    );

    expect(payload.commitHash).toBe("abc123");
    expect(payload.commitHashes).toBeUndefined();
    expect(payload.applyId).toBe("change-set-1");
  });

  it("groups several contributions and withholds singular commitHash", () => {
    const payload = buildSelfModCardPayload(
      publishedSet([
        staged({ applyId: "run-1", commitHash: "abc123" }),
        staged({
          applyId: "run-2",
          commitHash: "def456",
          files: ["desktop/src/b.tsx", "desktop/src/a.tsx"],
        }),
      ]),
    );

    expect(payload).toMatchObject({
      applyId: "change-set-1",
      changeSetId: "change-set-1",
      commitHashes: ["abc123", "def456"],
      files: ["desktop/src/a.tsx", "desktop/src/b.tsx"],
    });
    expect(payload.commitHash).toBeUndefined();
  });

  it("withholds every Undo selector when only part of a group committed", () => {
    const payload = buildSelfModCardPayload(
      publishedSet([
        staged({ applyId: "run-1", commitHash: "abc123" }),
        staged({ applyId: "run-2", files: ["desktop/src/b.tsx"] }),
      ]),
    );

    expect(payload.commitHashes).toBeUndefined();
    expect(payload.commitHash).toBeUndefined();
  });

  it("withholds grouped Undo when contributions repeat a commit hash", () => {
    const payload = buildSelfModCardPayload(
      publishedSet([
        staged({ applyId: "run-1", commitHash: "abc123" }),
        staged({ applyId: "run-2", commitHash: "abc123" }),
      ]),
    );

    expect(payload.commitHashes).toBeUndefined();
    expect(payload.commitHash).toBeUndefined();
  });
});

describe("claimPublishedSelfModChangeSet", () => {
  it("does not attach a published set outside its terminal completion boundary", () => {
    const contribution = staged({
      applyId: "run-1",
      changeSetId: "set-1",
      completionEventId: "completion-1",
    });

    expect(
      claimPublishedSelfModChangeSet({
        pending: [contribution],
        conversationId: "conv-1",
        assistantMessageEventId: "assistant-unrelated",
        completionEventId: "",
      }),
    ).toBeNull();
    expect(contribution.assistantMessageEventId).toBeUndefined();
  });

  it("ignores finalized but unpublished child contributions", () => {
    const child = staged({ applyId: "child-run" });
    expect(
      claimPublishedSelfModChangeSet({
        pending: [child],
        conversationId: "conv-1",
        assistantMessageEventId: "assistant-1",
        completionEventId: "completion-1",
      }),
    ).toBeNull();
    expect(child.assistantMessageEventId).toBeUndefined();
  });

  it("claims only one published set and leaves a later set for a later reply", () => {
    const first = staged({
      applyId: "run-1",
      changeSetId: "set-1",
      completionEventId: "completion-1",
    });
    const second = staged({
      applyId: "run-2",
      changeSetId: "set-2",
      completionEventId: "completion-2",
    });

    const claimed = claimPublishedSelfModChangeSet({
      pending: [first, second],
      conversationId: "conv-1",
      assistantMessageEventId: "assistant-1",
      completionEventId: "completion-1",
    });

    expect(claimed?.changeSetId).toBe("set-1");
    expect(first.assistantMessageEventId).toBe("assistant-1");
    expect(second.assistantMessageEventId).toBeUndefined();
  });

  it("attaches a completion's published set only once", () => {
    const contribution = staged({
      applyId: "run-1",
      changeSetId: "set-1",
      completionEventId: "completion-1",
    });
    const args = {
      pending: [contribution],
      conversationId: "conv-1",
      assistantMessageEventId: "assistant-1",
      completionEventId: "completion-1",
    };

    expect(claimPublishedSelfModChangeSet(args)?.changeSetId).toBe("set-1");
    expect(claimPublishedSelfModChangeSet(args)).toBeNull();
  });
});
