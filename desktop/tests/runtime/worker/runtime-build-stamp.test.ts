import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeRuntimeBuildStamp,
  resolveRuntimeBundleRoot,
  RUNTIME_BUILD_STAMP_UNAVAILABLE,
} from "../../../../runtime/worker/runtime-build-stamp.js";

const tempDirs: string[] = [];

const makeRuntimeTree = () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "stella-stamp-test-"));
  tempDirs.push(base);
  const treeRoot = path.join(base, "runtime");
  mkdirSync(path.join(treeRoot, "worker"), { recursive: true });
  mkdirSync(path.join(treeRoot, "kernel"), { recursive: true });
  mkdirSync(path.join(treeRoot, "kernel", "storage"), { recursive: true });
  writeFileSync(path.join(treeRoot, "worker", "entry.js"), "// entry v1\n");
  writeFileSync(path.join(treeRoot, "kernel", "agent.js"), "// kernel v1\n");
  writeFileSync(
    path.join(treeRoot, "kernel", "storage", "session-store.js"),
    "// host-owned, not worker-restart-relevant\n",
  );
  return {
    treeRoot,
    entryPath: path.join(treeRoot, "worker", "entry.js"),
  };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("computeRuntimeBuildStamp", () => {
  it("resolves the bundle root one level above the entry directory", () => {
    expect(resolveRuntimeBundleRoot("/a/b/runtime/worker/entry.js")).toBe(
      path.resolve("/a/b/runtime"),
    );
  });

  it("is stable for an unchanged tree", () => {
    const { entryPath } = makeRuntimeTree();
    const first = computeRuntimeBuildStamp(entryPath);
    const second = computeRuntimeBuildStamp(entryPath);
    expect(first).not.toBe(RUNTIME_BUILD_STAMP_UNAVAILABLE);
    expect(second).toBe(first);
  });

  it("changes when a worker-restart-relevant file changes", () => {
    const { treeRoot, entryPath } = makeRuntimeTree();
    const before = computeRuntimeBuildStamp(entryPath);
    writeFileSync(
      path.join(treeRoot, "kernel", "agent.js"),
      "// kernel v2 — different size\n",
    );
    const after = computeRuntimeBuildStamp(entryPath);
    expect(after).not.toBe(before);
  });

  it("changes when only the mtime of a relevant file changes", () => {
    const { treeRoot, entryPath } = makeRuntimeTree();
    const before = computeRuntimeBuildStamp(entryPath);
    const target = path.join(treeRoot, "worker", "entry.js");
    const future = new Date(Date.now() + 60_000);
    utimesSync(target, future, future);
    const after = computeRuntimeBuildStamp(entryPath);
    expect(after).not.toBe(before);
  });

  it("ignores host-owned runtime paths that never restart the worker", () => {
    const { treeRoot, entryPath } = makeRuntimeTree();
    const before = computeRuntimeBuildStamp(entryPath);
    writeFileSync(
      path.join(treeRoot, "kernel", "storage", "session-store.js"),
      "// changed host-owned content that should not affect the stamp\n",
    );
    const after = computeRuntimeBuildStamp(entryPath);
    expect(after).toBe(before);
  });

  it("returns the unavailable sentinel for a missing tree", () => {
    expect(computeRuntimeBuildStamp("/nonexistent/runtime/worker/entry.js")).toBe(
      RUNTIME_BUILD_STAMP_UNAVAILABLE,
    );
    expect(computeRuntimeBuildStamp("")).toBe(RUNTIME_BUILD_STAMP_UNAVAILABLE);
  });
});
