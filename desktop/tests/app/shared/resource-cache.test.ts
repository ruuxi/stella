import { describe, expect, it } from "vitest";

import { createResourceStore } from "@/shared/lib/resource-cache";

type RevisionedValue = {
  revision: number;
  value: string;
};

describe("resource cache external updates", () => {
  it("lets a newer forced response win over an older background push", async () => {
    let resolveForced!: (value: RevisionedValue) => void;
    const forcedResponse = new Promise<RevisionedValue>((resolve) => {
      resolveForced = resolve;
    });
    const store = createResourceStore<"catalog", RevisionedValue>({
      fetcher: async () => await forcedResponse,
      accept: (next, current) => next.revision > current.revision,
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
      accept: (next, current) => next.revision > current.revision,
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
});
