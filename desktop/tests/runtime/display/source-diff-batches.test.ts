import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shell/display/tab-store", () => ({
  displayTabs: { openTab: vi.fn() },
}));

const {
  sourceDiffBatches,
  pushAndOpenSourceDiffBatch,
  peekSourceDiffBatches,
  SOURCE_DIFF_TAB_ID,
} = await import("../../../src/shell/display/source-diff-batches");

const { displayTabs } = await import(
  "../../../src/shell/display/tab-store"
);

const sourceDiffPayload = (filePath: string, createdAt = 0) =>
  ({
    kind: "source-diff" as const,
    filePath,
    title: filePath.split("/").pop()!,
    createdAt,
  });

describe("sourceDiffBatches.push", () => {
  beforeEach(() => {
    sourceDiffBatches.clear();
    vi.mocked(displayTabs.openTab).mockClear();
  });

  it("ignores empty payload arrays", () => {
    sourceDiffBatches.push({ id: "t1", createdAt: 1, payloads: [] });
    expect(peekSourceDiffBatches()).toEqual({
      batches: [],
      activeBatchId: null,
    });
  });

  it("activates a freshly inserted batch", () => {
    sourceDiffBatches.push({
      id: "t1",
      createdAt: 1,
      payloads: [sourceDiffPayload("/x/a.ts")],
    });
    expect(peekSourceDiffBatches().activeBatchId).toBe("t1");
  });

  it("does not change activeBatchId when replacing in place", () => {
    sourceDiffBatches.push({
      id: "older",
      createdAt: 1,
      payloads: [sourceDiffPayload("/x/a.ts")],
    });
    sourceDiffBatches.push({
      id: "newer",
      createdAt: 2,
      payloads: [sourceDiffPayload("/x/b.ts")],
    });
    // "newer" was just inserted → active.
    expect(peekSourceDiffBatches().activeBatchId).toBe("newer");

    // User chips back to "older".
    sourceDiffBatches.select("older");
    expect(peekSourceDiffBatches().activeBatchId).toBe("older");

    // Same turn re-fires (e.g. streaming finalize) and pushes "newer"
    // again. This must NOT yank the user away from "older".
    sourceDiffBatches.push({
      id: "newer",
      createdAt: 3,
      payloads: [
        sourceDiffPayload("/x/b.ts"),
        sourceDiffPayload("/x/c.ts"),
      ],
    });
    const snapshot = peekSourceDiffBatches();
    expect(snapshot.activeBatchId).toBe("older");
    // Replacement happened in place — payload list updated.
    const updated = snapshot.batches.find((entry) => entry.id === "newer")!;
    expect(updated.payloads).toHaveLength(2);
  });

  it("evicts the oldest batch when the ring is full", () => {
    for (let index = 0; index < 5; index += 1) {
      sourceDiffBatches.push({
        id: `b-${index}`,
        createdAt: index,
        payloads: [sourceDiffPayload(`/x/${index}.ts`)],
      });
    }
    const ids = peekSourceDiffBatches().batches.map((entry) => entry.id);
    expect(ids).toEqual(["b-4", "b-3", "b-2"]);
  });
});

describe("sourceDiffBatches.pushAndActivate", () => {
  beforeEach(() => {
    sourceDiffBatches.clear();
  });

  it("activates an existing batch when re-pushed (user clicked it)", () => {
    sourceDiffBatches.push({
      id: "older",
      createdAt: 1,
      payloads: [sourceDiffPayload("/x/a.ts")],
    });
    sourceDiffBatches.push({
      id: "newer",
      createdAt: 2,
      payloads: [sourceDiffPayload("/x/b.ts")],
    });
    sourceDiffBatches.select("older");
    expect(peekSourceDiffBatches().activeBatchId).toBe("older");

    sourceDiffBatches.pushAndActivate({
      id: "newer",
      createdAt: 3,
      payloads: [sourceDiffPayload("/x/b.ts")],
    });
    expect(peekSourceDiffBatches().activeBatchId).toBe("newer");
  });
});

describe("sourceDiffBatches.select", () => {
  beforeEach(() => {
    sourceDiffBatches.clear();
  });

  it("is a no-op for unknown ids", () => {
    sourceDiffBatches.push({
      id: "t1",
      createdAt: 1,
      payloads: [sourceDiffPayload("/x/a.ts")],
    });
    sourceDiffBatches.select("does-not-exist");
    expect(peekSourceDiffBatches().activeBatchId).toBe("t1");
  });
});

describe("pushAndOpenSourceDiffBatch", () => {
  beforeEach(() => {
    sourceDiffBatches.clear();
    vi.mocked(displayTabs.openTab).mockClear();
  });

  it("pushes (with activation) and opens the singleton tab", () => {
    const spec = {
      id: SOURCE_DIFF_TAB_ID,
      kind: "source-diff" as const,
      title: "Code changes",
      render: () => null,
    };
    sourceDiffBatches.push({
      id: "older",
      createdAt: 1,
      payloads: [sourceDiffPayload("/x/a.ts")],
    });
    sourceDiffBatches.push({
      id: "newer",
      createdAt: 2,
      payloads: [sourceDiffPayload("/x/b.ts")],
    });
    sourceDiffBatches.select("older");

    pushAndOpenSourceDiffBatch(
      {
        id: "newer",
        createdAt: 3,
        payloads: [sourceDiffPayload("/x/b.ts")],
      },
      spec,
    );

    const snapshot = peekSourceDiffBatches();
    expect(snapshot.activeBatchId).toBe("newer");
    expect(displayTabs.openTab).toHaveBeenCalledTimes(1);
    expect(vi.mocked(displayTabs.openTab).mock.calls[0]![0].id).toBe(
      SOURCE_DIFF_TAB_ID,
    );
  });
});
