import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDesktopDatabase } from "../../../../../runtime/kernel/storage/database-init.js";
import { SelfModPendingStore } from "../../../../../runtime/kernel/storage/self-mod-pending-store.js";
import type { SqliteDatabase } from "../../../../../runtime/kernel/storage/shared.js";

const applyResult = (runId: string) => ({
  appliedRuns: [
    {
      runId,
      paths: [`desktop/src/${runId}.tsx`],
      files: [
        {
          path: `desktop/src/${runId}.tsx`,
          content: `export const ${runId.replaceAll("-", "_")} = true;\n`,
        },
      ],
      runtimeRestartRelevantPaths: [],
      processRestartRelevantPaths: [],
      restartRelevantPaths: [],
      fullReloadRelevantPaths: [`desktop/src/${runId}.tsx`],
    },
  ],
  restartRelevantRunIds: [runId],
  hasRestartRelevantPaths: false,
  hasRuntimeRestartRelevantPaths: false,
  hasProcessRestartRelevantPaths: false,
  hasFullReloadRelevantPaths: true,
});

describe("SelfModPendingStore", () => {
  let db: SqliteDatabase;
  let store: SelfModPendingStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    store = new SelfModPendingStore(db, "/repo/stella");
  });

  afterEach(() => {
    db.close();
  });

  it("rehydrates staged, published, and attached contributions in finalize order", () => {
    store.stageContribution({
      applyId: "child-run",
      commitHash: "abc123",
      applyResult: applyResult("child-run"),
      conversationId: "conv-1",
      files: ["desktop/src/child-run.tsx"],
      ownerThreadId: "general-1",
    });
    store.stageContribution({
      applyId: "parent-run",
      applyResult: applyResult("parent-run"),
      conversationId: "conv-1",
      files: ["desktop/src/parent-run.tsx"],
      ownerThreadId: "general-1",
    });

    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });
    expect(published.changeSet.changeSetId).toBe(
      "self-mod-change-set:completion-1",
    );
    expect(published.contributions.map((entry) => entry.applyId)).toEqual([
      "child-run",
      "parent-run",
    ]);

    store.markAttached({
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
    });

    const rehydrated = new SelfModPendingStore(
      db,
      "/repo/stella",
    ).listPendingContributions();
    expect(rehydrated.map((entry) => entry.applyId)).toEqual([
      "child-run",
      "parent-run",
    ]);
    expect(rehydrated[0]).toMatchObject({
      commitHash: "abc123",
      changeSetId: "self-mod-change-set:completion-1",
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
      ownerThreadId: "general-1",
    });
    expect(rehydrated[0]?.applyResult).toEqual(applyResult("child-run"));
    expect(
      new SelfModPendingStore(db, "/repo/other").listPendingContributions(),
    ).toEqual([]);
  });

  it("fences completion replay so later contributions cannot join an old set", () => {
    store.stageContribution({
      applyId: "first-run",
      applyResult: applyResult("first-run"),
      conversationId: "conv-1",
      files: ["desktop/src/first-run.tsx"],
      ownerThreadId: "general-1",
    });
    const first = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });

    store.stageContribution({
      applyId: "later-run",
      applyResult: applyResult("later-run"),
      conversationId: "conv-1",
      files: ["desktop/src/later-run.tsx"],
      ownerThreadId: "general-1",
    });
    const replay = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });

    expect(replay.changeSet.changeSetId).toBe(first.changeSet.changeSetId);
    expect(replay.contributions.map((entry) => entry.applyId)).toEqual([
      "first-run",
    ]);
    expect(
      store
        .listPendingContributions()
        .find((entry) => entry.applyId === "later-run")?.changeSetId,
    ).toBeUndefined();
  });

  it("recovers an interrupted apply claim and deletes contributions only on success", () => {
    store.stageContribution({
      applyId: "run-1",
      commitHash: "abc123",
      applyResult: applyResult("run-1"),
      conversationId: "conv-1",
      files: ["desktop/src/run-1.tsx"],
      ownerThreadId: "general-1",
    });
    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-1",
    });
    store.markAttached({
      completionEventId: "completion-1",
      assistantMessageEventId: "assistant-1",
    });

    expect(
      store.beginApply({ applyId: published.changeSet.changeSetId })
        ?.contributions,
    ).toHaveLength(1);
    expect(
      store.beginApply({ applyId: published.changeSet.changeSetId }),
    ).toBeNull();

    const restartedStore = new SelfModPendingStore(db, "/repo/stella");
    restartedStore.recoverInterruptedApplies();
    const retry = restartedStore.beginApply({
      applyId: published.changeSet.changeSetId,
    });
    expect(retry?.contributions[0]?.applyResult).toEqual(applyResult("run-1"));

    restartedStore.completeApply(published.changeSet.changeSetId);
    expect(restartedStore.listPendingContributions()).toEqual([]);
    expect(
      restartedStore.beginApply({
        applyId: published.changeSet.changeSetId,
      }),
    ).toBeNull();
    expect(
      restartedStore.getChangeSet(published.changeSet.changeSetId),
    ).toMatchObject({
      status: "applied",
      assistantMessageEventId: "assistant-1",
      commitHashes: ["abc123"],
    });
  });

  it("retains the immutable exact commit set after applied contributions are deleted", () => {
    for (const [applyId, commitHash] of [
      ["run-1", "abc123"],
      ["run-2", "def456"],
    ] as const) {
      store.stageContribution({
        applyId,
        commitHash,
        applyResult: applyResult(applyId),
        conversationId: "conv-1",
        files: [`desktop/src/${applyId}.tsx`],
        ownerThreadId: "general-1",
      });
    }
    const published = store.publishCompletion({
      conversationId: "conv-1",
      ownerThreadId: "general-1",
      completionEventId: "completion-group",
    });

    expect(published.changeSet.commitHashes).toEqual(["abc123", "def456"]);
    store.completeApply(published.changeSet.changeSetId);
    expect(store.listPendingContributions()).toEqual([]);
    expect(store.getChangeSet(published.changeSet.changeSetId)).toMatchObject({
      status: "applied",
      commitHashes: ["abc123", "def456"],
    });
  });
});
