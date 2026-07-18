import { describe, expect, it, vi } from "vitest";

import { createResourceStore } from "@/shared/lib/resource-cache";

type RevisionedValue = {
  revision: number;
  value: string;
};

const compareRevision = (next: RevisionedValue, current: RevisionedValue) =>
  next.revision - current.revision;

describe("resource cache external updates", () => {
  it("lets a newer forced response win over an older background push", async () => {
    let resolveForced!: (value: RevisionedValue) => void;
    const forcedResponse = new Promise<RevisionedValue>((resolve) => {
      resolveForced = resolve;
    });
    const store = createResourceStore<"catalog", RevisionedValue>({
      fetcher: async () => await forcedResponse,
      compare: compareRevision,
    });
    store.set("catalog", { revision: 1, value: "initial" });

    const forced = store.ensure("catalog", { force: true });
    store.push("catalog", { revision: 2, value: "background" });
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 2, value: "background" },
      isFetching: true,
    });

    resolveForced({ revision: 3, value: "forced" });
    await expect(forced).resolves.toEqual({
      revision: 3,
      value: "forced",
    });
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 3, value: "forced" },
      isFetching: false,
    });
  });

  it("updates an idle cache but rejects a stale fetch response", async () => {
    let resolveForced!: (value: RevisionedValue) => void;
    const forcedResponse = new Promise<RevisionedValue>((resolve) => {
      resolveForced = resolve;
    });
    const store = createResourceStore<"catalog", RevisionedValue>({
      fetcher: async () => await forcedResponse,
      compare: compareRevision,
    });
    store.set("catalog", { revision: 1, value: "initial" });
    store.push("catalog", { revision: 2, value: "idle-push" });
    expect(store.get("catalog").data).toEqual({
      revision: 2,
      value: "idle-push",
    });

    const forced = store.ensure("catalog", { force: true });
    store.push("catalog", { revision: 4, value: "newest-push" });
    resolveForced({ revision: 3, value: "stale-forced" });
    await forced;
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 4, value: "newest-push" },
      isFetching: false,
    });
  });

  it("retains equal-revision data while clearing errors and ignores lower revisions", async () => {
    const fetcher = vi
      .fn<() => Promise<RevisionedValue>>()
      .mockRejectedValue(new Error("runtime unavailable"));
    const store = createResourceStore<"catalog", RevisionedValue>({
      fetcher,
      compare: compareRevision,
    });
    store.set("catalog", { revision: 7, value: "last-good" });

    await expect(store.ensure("catalog", { force: true })).rejects.toThrow(
      "runtime unavailable",
    );
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 7, value: "last-good" },
      error: expect.objectContaining({ message: "runtime unavailable" }),
    });

    store.push("catalog", { revision: 7, value: "equal-but-different" });
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 7, value: "last-good" },
      error: null,
    });

    await expect(store.ensure("catalog", { force: true })).rejects.toThrow(
      "runtime unavailable",
    );
    store.push("catalog", { revision: 6, value: "older" });
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 7, value: "last-good" },
      error: expect.objectContaining({ message: "runtime unavailable" }),
    });

    store.push("catalog", { revision: 8, value: "newer" });
    expect(store.get("catalog")).toMatchObject({
      data: { revision: 8, value: "newer" },
      error: null,
    });
  });

  it("does not let an older in-flight failure restore an error after equal reconciliation", async () => {
    let rejectForced!: (error: Error) => void;
    const forcedResponse = new Promise<RevisionedValue>((_resolve, reject) => {
      rejectForced = reject;
    });
    const store = createResourceStore<"catalog", RevisionedValue>({
      fetcher: async () => await forcedResponse,
      compare: compareRevision,
    });
    store.set("catalog", { revision: 7, value: "last-good" });

    const forced = store.ensure("catalog", { force: true });
    store.push("catalog", { revision: 7, value: "equal-but-different" });
    rejectForced(new Error("older refresh failed"));
    await expect(forced).rejects.toThrow("older refresh failed");

    expect(store.get("catalog")).toMatchObject({
      data: { revision: 7, value: "last-good" },
      error: null,
      isFetching: false,
    });
  });
});
