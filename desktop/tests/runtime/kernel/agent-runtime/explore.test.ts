import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_FINDINGS,
  runExplore,
  sanitizeExploreToolArgs,
} from "../../../../../runtime/kernel/agent-runtime/explore.js";

const activeRoots = new Set<string>();

const createStateRoot = async (): Promise<string> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-explore-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootPath, { recursive: true });
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    await rm(rootPath, { recursive: true, force: true });
  }
  activeRoots.clear();
});

describe("sanitizeExploreToolArgs", () => {
  it("pins Grep to state/ when no path is provided", async () => {
    const rootPath = await createStateRoot();
    const result = await sanitizeExploreToolArgs("Grep", { pattern: "skill" }, rootPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.path).toBe(rootPath);
  });

  it("rejects Read paths outside state/", async () => {
    const rootPath = await createStateRoot();
    const result = await sanitizeExploreToolArgs(
      "Read",
      { file_path: "../package.json" },
      rootPath,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("inside state/");
  });
});

describe("runExplore", () => {
  it("returns the fallback block immediately when aborted before start", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runExplore({
      context: {} as never,
      conversationId: "conv-1",
      taskDescription: "Inspect something",
      taskPrompt: "Look in state",
      signal: controller.signal,
    });
    expect(result).toBe(FALLBACK_FINDINGS);
  });
});
