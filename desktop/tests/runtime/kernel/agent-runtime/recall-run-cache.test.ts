import { describe, expect, it, vi } from "vitest";

import {
  RecallRunCache,
  buildRecallLookupCacheKey,
} from "../../../../../runtime/kernel/agent-runtime/recall-run-cache.js";

describe("RecallRunCache", () => {
  it("normalizes prompt whitespace and term order", () => {
    expect(
      buildRecallLookupCacheKey("  Prior   Decision ", ["Repo", "path"]),
    ).toBe(buildRecallLookupCacheKey("prior decision", ["PATH", "repo"]));
  });

  it("collapses concurrent duplicate lookups within one orchestrator run", async () => {
    const cache = new RecallRunCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(async () => {
      await gate;
      return { status: "no_match" as const, brief: "Nothing relevant found." };
    });

    const first = cache.getOrCreate(
      "run-1",
      "Prior decision",
      ["repo"],
      create,
    );
    const duplicate = cache.getOrCreate(
      "run-1",
      " prior   decision ",
      ["REPO"],
      create,
    );
    release();

    await expect(first).resolves.toEqual({
      status: "no_match",
      brief: "Nothing relevant found.",
    });
    await expect(duplicate).resolves.toEqual({
      status: "no_match",
      brief: "Nothing relevant found.",
      cached: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across orchestrator runs", async () => {
    const cache = new RecallRunCache();
    const create = vi.fn(async () => ({
      status: "found" as const,
      brief: "A result.",
    }));

    await cache.getOrCreate("run-1", "lookup", ["term"], create);
    await cache.getOrCreate("run-2", "lookup", ["term"], create);

    expect(create).toHaveBeenCalledTimes(2);
  });
});
