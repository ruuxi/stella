import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isHmrPathUnderDirectory,
  resolveHmrToolTargetPath,
} from "../../../../../runtime/kernel/runner/task-orchestration.js";

describe("task-orchestration HMR target resolution", () => {
  const stellaRoot = path.resolve("/tmp/stella-root");

  it("resolves explicit bash file targets (legacy)", () => {
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

  it("treats Exec programs that call mutating tools as writes in stellaRoot", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Exec",
      {
        summary: "scan and update files",
        source:
          "await tools.write_file({ path: '/tmp/stella-root/desktop/tmp.txt', content: 'x' });",
      },
      stellaRoot,
    );

    expect(targetPath).toBe(stellaRoot);
    expect(targetPath && isHmrPathUnderDirectory(targetPath, stellaRoot)).toBe(true);
  });

  it("treats clearly read-only Exec programs as non-mutating", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Exec",
      {
        summary: "read source files",
        source: "const files = await tools.glob({ pattern: 'desktop/src/**/*.ts' });",
      },
      stellaRoot,
    );

    expect(targetPath).toBeNull();
  });

  it("keeps Exec conservative for ambiguous code (require / direct fs)", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Exec",
      {
        summary: "load helpers and run script",
        source:
          "const fs = require('node:fs/promises'); return await fs.readFile('README.md', 'utf8');",
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

  it("cannot infer Exec writes without a stella root fallback", () => {
    const targetPath = resolveHmrToolTargetPath(
      "Exec",
      {
        summary: "read only",
        source: "const files = await tools.glob({ pattern: '**/*.ts' });",
      },
    );

    expect(targetPath).toBeNull();
  });
});
