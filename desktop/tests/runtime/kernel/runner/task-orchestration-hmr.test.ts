import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isHmrPathUnderDirectory,
  resolveHmrToolTargetPath,
} from "../../../../../runtime/kernel/runner/task-orchestration.js";

describe("task-orchestration HMR target resolution", () => {
  const stellaRoot = path.resolve("/tmp/stella-root");

  it("resolves explicit bash file targets", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Bash",
      {
        command: "echo hi > desktop/src/app.tsx",
        working_directory: stellaRoot,
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve(stellaRoot, "desktop/src/app.tsx"));
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("treats path-less bash commands as writes in the working directory", () => {
    const cwd = path.resolve(stellaRoot, "desktop");
    const targetPath = resolveHmrToolTargetPath(
      "Bash",
      {
        command: "bun install",
        working_directory: cwd,
      },
      stellaRoot,
    );

    expect(targetPath).toBe(cwd);
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("resolves relative working directories against stella root", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Bash",
      {
        command: "npm run build",
        working_directory: "desktop",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve(stellaRoot, "desktop"));
  });

  it("falls back to stella root when bash cwd is omitted", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Bash",
      {
        command: "bun install",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(stellaRoot);
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("treats ExecuteTypescript as a potential stella-root write", () => {
    const targetPath = resolveHmrToolTargetPath(
      "ExecuteTypescript",
      {
        summary: "scan and update files",
        code: "return await workspace.writeText('desktop/tmp.txt', 'x')",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(stellaRoot);
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("treats clearly read-only ExecuteTypescript as non-mutating", () => {
    const targetPath = resolveHmrToolTargetPath(
      "ExecuteTypescript",
      {
        summary: "read source files",
        code: "return await workspace.glob('desktop/src/**/*.ts')",
      },
      stellaRoot,
    );

    expect(targetPath).toBeNull();
  });

  it("keeps ExecuteTypescript conservative for ambiguous code", () => {
    const targetPath = resolveHmrToolTargetPath(
      "ExecuteTypescript",
      {
        summary: "load helpers and run script",
        code: "const fs = require('node:fs/promises'); return await fs.readFile('README.md', 'utf8');",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(stellaRoot);
  });

  it("does not mark non-stella working directories as in-repo", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Bash",
      {
        command: "bun install",
        working_directory: "/tmp",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(path.resolve("/tmp"));
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(false);
  });

  it("cannot infer ExecuteTypescript writes without a stella root fallback", () => {
    const targetPath = resolveHmrToolTargetPath(
      "ExecuteTypescript",
      {
        summary: "read only",
        code: "return await workspace.glob('**/*.ts')",
      },
    );

    expect(targetPath).toBeNull();
  });
});
